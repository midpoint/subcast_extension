/** The extension's single network owner and coordinator. Content scripts send what the page knows;
 *  panels ask for actions; this worker fetches captions, shared transcripts, translations and AI,
 *  writes IndexedDB, and streams events back. MV3 may stop this worker at any time, so every piece of
 *  lasting state lives in IndexedDB / chrome.storage, never only in memory. */
import { bestAudio } from '../src/lib/asr';
import { autoCaptionsMismatch, chooseTrack, clean, resegment } from '../src/lib/captions';
import { getEpisode, getGuide, putEpisode, putGuide, updateEpisode } from '../src/lib/db';
import { isKeyError, llmChat, llmReady } from '../src/lib/llm';
import { videoIdFromUrl, siteFromUrl } from '../src/lib/media';
import type { ContentRequest, OffscreenEvent, OffscreenRequest, PanelEvent, PanelRequest } from '../src/lib/messages';
import { podcastUnavailableMessage, resolvePodcastEpisode, SPOTIFY_DRM_NOTICE } from '../src/lib/podcast';
import { GUIDE_SYSTEM, guidePrompt, qaSystem, transcriptForModel } from '../src/lib/prompts';
import { ASR_PRESETS, getSettings, onSettingsChanged, saveSettings } from '../src/lib/settings';
import { lookupGuide, lookupTranscript, uploadTranscript, type SharedTranscript } from '../src/lib/shared';
import { needsTranslation, shouldTranslate } from '../src/lib/translate';
import { punctuationTargets, segmentTexts } from '../src/lib/punctuate';
import type { CaptionTrack, EpisodeRecord, TabSnapshot, VideoMeta } from '../src/lib/types';
import { EPISODE_KEY, isPodcastSite } from '../src/lib/types';
import { fetchInnerTubeMeta, fetchTrackSegments } from '../src/lib/youtube';

const APP_VERSION = chrome.runtime.getManifest().version;

const tabStates = new Map<number, TabSnapshot>();
const panelPorts = new Set<chrome.runtime.Port>();
const panelChats = new Map<chrome.runtime.Port, Set<string>>();
const panelTabs = new Map<chrome.runtime.Port, number | null>();
const contentPorts = new Map<number, chrome.runtime.Port>();
const pipelineRuns = new Map<string, Promise<void>>();
const translating = new Set<string>();
const punctuating = new Set<string>();
const asrJobs = new Set<string>();
const uploading = new Set<string>();
const guideJobs = new Set<string>();
const chatJobs = new Map<string, AbortController>();
const subtitleTimers = new Map<number, ReturnType<typeof setTimeout>>();
let activeTabId: number | null = null;
let revision = 0;

function log(...args: unknown[]) {
  console.log('[subcast]', ...args);
}

function initialStatus(url: string): TabSnapshot['status'] {
  return siteFromUrl(url) === 'spotify' ? { state: 'unsupported', message: SPOTIFY_DRM_NOTICE } : { state: 'idle' };
}

function emptySnapshot(tabId: number, url: string): TabSnapshot {
  return {
    tabId,
    url,
    videoId: videoIdFromUrl(url),
    meta: null,
    time: 0,
    duration: 0,
    paused: true,
    status: initialStatus(url),
    revision,
  };
}

function ensureTab(tabId: number, url = ''): TabSnapshot {
  let st = tabStates.get(tabId);
  if (!st) {
    st = emptySnapshot(tabId, url);
    tabStates.set(tabId, st);
  } else if (url && url !== st.url) {
    st.url = url;
    const id = videoIdFromUrl(url);
    if (id !== st.videoId) {
      st.videoId = id;
      st.meta = null;
      st.time = 0;
      st.duration = 0;
      st.status = initialStatus(url);
    }
  }
  return st;
}

function snapshotFor(tabId: number, url = ''): TabSnapshot {
  return { ...ensureTab(tabId, url), revision };
}

function safePost(port: chrome.runtime.Port, msg: PanelEvent) {
  try {
    port.postMessage(msg);
  } catch {
    panelPorts.delete(port);
  }
}

function broadcast(msg: PanelEvent) {
  for (const p of [...panelPorts]) safePost(p, msg);
}

/** Sends each panel the tab it follows (an explicit ?tabId for debugging, else the active tab). */
function broadcastSnapshot(tabId?: number) {
  for (const p of [...panelPorts]) {
    const t = panelTabs.get(p) ?? activeTabId;
    if (t == null) continue;
    if (tabId != null && t !== tabId) continue;
    const st = tabStates.get(t);
    if (st) safePost(p, { type: 'SNAPSHOT', snapshot: { ...st, revision } });
  }
}

function setStatus(tabId: number, status: TabSnapshot['status']) {
  const st = ensureTab(tabId);
  st.status = status;
  broadcastSnapshot(tabId);
}

function setStatusForVideo(videoId: string, status: TabSnapshot['status']) {
  for (const [tabId, st] of tabStates) {
    if (st.videoId === videoId) setStatus(tabId, status);
  }
}

async function activeTab(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) {
      activeTabId = tab.id;
      ensureTab(tab.id, tab.url ?? '');
      return tab.id;
    }
  } catch {
    /* no window */
  }
  return activeTabId;
}

async function sendToContent(tabId: number, msg: unknown) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    /* the tab navigated away or has no content script */
  }
}

async function sendSettingsToContent(tabId: number) {
  const s = await getSettings();
  await sendToContent(tabId, {
    type: 'SETTINGS',
    displayMode: s.displayMode,
    overlay: s.overlay,
    overlayMode: s.overlayMode,
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Tab / panel plumbing                                                                             */
/* ------------------------------------------------------------------------------------------------ */

function handleMeta(tabId: number, meta: VideoMeta) {
  const st = ensureTab(tabId, meta.url);
  const sameVideo = st.videoId === meta.videoId && st.meta != null;
  if (!sameVideo) {
    st.videoId = meta.videoId;
    st.meta = meta;
    st.time = 0;
    st.duration = meta.duration || 0;
    st.status = { state: 'loading', step: '准备字幕' };
  } else {
    const old = st.meta!;
    st.meta = {
      ...old,
      ...meta,
      tracks: meta.tracks.length ? meta.tracks : old.tracks,
      audio: meta.audio.length ? meta.audio : old.audio,
      originalLanguage: meta.originalLanguage ?? old.originalLanguage,
      // Resolution results survive a RESYNC from the page, which only knows the DOM.
      audioUrl: meta.audioUrl ?? old.audioUrl,
      albumId: meta.albumId ?? old.albumId,
      sharedKeys: meta.sharedKeys?.length ? meta.sharedKeys : old.sharedKeys,
      site: meta.site ?? old.site,
      title: meta.title || old.title,
      channel: meta.channel || old.channel,
      duration: meta.duration || old.duration,
    };
  }
  tabStates.set(tabId, st);
  broadcastSnapshot(tabId);
  void sendSettingsToContent(tabId);
  if (!sameVideo) {
    log('video', meta.videoId, meta.title);
    void ensureEpisode(tabId, meta);
  }
}

function handleContentRequest(msg: ContentRequest, sender: chrome.runtime.MessageSender): void {
  if (msg.type === 'OPEN_PANEL') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      void chrome.sidePanel.open({ tabId }).catch(() => {
        broadcast({ type: 'TOAST', kind: 'info', message: '请点浏览器工具栏上的 SubCast 图标打开侧边栏' });
      });
    }
    return;
  }
  if (msg.type === 'YT_META') {
    const tabId = sender.tab?.id;
    if (tabId != null) handleMeta(tabId, msg.meta);
    return;
  }
  if (msg.type === 'CONTENT_READY') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const st = ensureTab(tabId, msg.url);
    if (msg.videoId == null) {
      st.videoId = null;
      st.meta = null;
      st.status = { state: 'idle' };
      tabStates.set(tabId, st);
      broadcastSnapshot(tabId);
      void sendToContent(tabId, { type: 'CLEAR' });
    } else if (st.videoId !== msg.videoId) {
      st.videoId = msg.videoId;
      st.meta = null;
      st.status = { state: 'loading', step: '准备字幕' };
      tabStates.set(tabId, st);
      broadcastSnapshot(tabId);
      void sendToContent(tabId, { type: 'RESYNC' });
    }
  }
}

function onContentPort(port: chrome.runtime.Port) {
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  contentPorts.set(tabId, port);
  const st = ensureTab(tabId, port.sender?.tab?.url ?? '');
  broadcastSnapshot(tabId);
  void sendSettingsToContent(tabId);
  if (!st.meta && st.videoId) void sendToContent(tabId, { type: 'RESYNC' });
  // A fresh content script (page reload, or the worker was recycled) needs the cached episode
  // pushed again; the background's tab state outlives the page.
  if (st.meta) void ensureEpisode(tabId, st.meta).catch((e) => log('resend episode failed', e));
  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'META' && msg.meta) {
      handleMeta(tabId, msg.meta as VideoMeta);
      return;
    }
    if (msg?.type === 'STATE') {
      const cur = tabStates.get(tabId);
      if (!cur || (msg.videoId && cur.videoId && msg.videoId !== cur.videoId)) return;
      cur.time = Number(msg.time) || 0;
      cur.duration = Number(msg.duration) || cur.duration;
      cur.paused = Boolean(msg.paused);
      broadcast({ type: 'TICK', videoId: cur.videoId ?? '', time: cur.time, duration: cur.duration, paused: cur.paused });
    }
  });
  port.onDisconnect.addListener(() => {
    if (contentPorts.get(tabId) === port) contentPorts.delete(tabId);
  });
}

async function panelTarget(port: chrome.runtime.Port): Promise<number | null> {
  const explicit = panelTabs.get(port);
  if (explicit != null) {
    const exists = await chrome.tabs.get(explicit).catch(() => null);
    if (exists) return explicit;
  }
  return activeTab();
}

async function sendSnapshotToPanel(port: chrome.runtime.Port): Promise<void> {
  const tabId = await panelTarget(port);
  if (tabId == null) {
    safePost(port, { type: 'TOAST', kind: 'error', message: '没有找到活动的浏览器标签页' });
    return;
  }
  safePost(port, { type: 'SNAPSHOT', snapshot: snapshotFor(tabId) });
  const st = tabStates.get(tabId);
  if (!st?.meta) await sendToContent(tabId, { type: 'RESYNC' });
  const rec = st?.videoId ? await getEpisode(EPISODE_KEY(st.videoId)) : null;
  if (rec) safePost(port, { type: 'EPISODE_UPDATED', videoId: rec.videoId, revision });
}

function onPanelPort(port: chrome.runtime.Port) {
  panelPorts.add(port);
  panelTabs.set(port, null);
  panelChats.set(port, new Set());
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    panelTabs.delete(port);
    for (const id of panelChats.get(port) ?? []) chatJobs.get(id)?.abort();
    panelChats.delete(port);
  });
  port.onMessage.addListener((msg: PanelRequest) => {
    if (msg.type === 'PANEL_HELLO' || msg.type === 'RELOAD_STATE') {
      if (msg.tabId != null) panelTabs.set(port, msg.tabId);
      void sendSnapshotToPanel(port);
      return;
    }
    void handlePanel(port, msg).catch((e) => {
      safePost(port, { type: 'TOAST', kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  });
}

async function handlePanel(port: chrome.runtime.Port, msg: PanelRequest): Promise<void> {
  switch (msg.type) {
    case 'PANEL_HELLO':
    case 'RELOAD_STATE': {
      if (msg.tabId != null) panelTabs.set(port, msg.tabId);
      await sendSnapshotToPanel(port);
      return;
    }
    case 'LOAD': {
      const tabId = await panelTarget(port);
      if (tabId == null) return;
      const st = ensureTab(tabId);
      if (!st.meta || st.videoId !== msg.videoId) {
        await sendToContent(tabId, { type: 'RESYNC' });
        return;
      }
      await ensureEpisode(tabId, st.meta, msg.force);
      return;
    }
    case 'LOAD_TRACK': {
      const st = findVideoState(msg.videoId);
      if (st) await loadTrack(st.tabId, msg.videoId, msg.track);
      return;
    }
    case 'TRANSLATE': {
      const st = findVideoState(msg.videoId);
      const rec = await getEpisode(EPISODE_KEY(msg.videoId));
      if (st && rec) void startTranslate(st.tabId, rec);
      return;
    }
    case 'CANCEL_TRANSLATE': {
      translating.delete(msg.videoId);
      await sendOffscreen({ type: 'OFFSCREEN_CANCEL', videoId: msg.videoId });
      setStatusForVideo(msg.videoId, { state: 'ready' });
      return;
    }
    case 'SEEK': {
      const tabId = await panelTarget(port);
      if (tabId != null) await sendToContent(tabId, { type: 'SEEK', seconds: Math.max(0, msg.seconds) });
      return;
    }
    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return;
    case 'SET_DISPLAY': {
      await saveSettings({
        displayMode: msg.displayMode,
        ...(msg.overlay != null ? { overlay: msg.overlay } : {}),
        ...(msg.overlayMode ? { overlayMode: msg.overlayMode } : {}),
      });
      const tabId = await panelTarget(port);
      if (tabId != null) {
        await sendSettingsToContent(tabId);
        scheduleSubtitles(tabId);
      }
      return;
    }
    case 'LOOKUP_GUIDE':
      void lookupGuideForPanel(port, msg.videoId);
      return;
    case 'GENERATE_GUIDE':
      void generateGuide(port, msg.videoId, Boolean(msg.force));
      return;
    case 'CHAT':
      panelChats.get(port)?.add(msg.requestId);
      void handleChat(port, msg);
      return;
    case 'CHAT_CANCEL':
      chatJobs.get(msg.requestId)?.abort();
      return;
    case 'RUN_ASR': {
      const st = findVideoState(msg.videoId);
      if (st?.meta) void startAsr(st.tabId, st.meta);
      else safePost(port, { type: 'ASR_ERROR', videoId: msg.videoId, message: '还没有读到这个页面的信息，请刷新页面' });
      return;
    }
  }
}

function findVideoState(videoId: string): TabSnapshot | null {
  for (const st of tabStates.values()) if (st.videoId === videoId) return st;
  return null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Episode pipeline                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const langRoot = (lang: string) => (lang.split(/[-_]/)[0] ?? lang).toLowerCase();

/** Older builds fell back to English when the player did not spell "original" in English (localized
 *  display names, dubbed videos with several auto tracks). When the audio language is now known and
 *  a matching track exists, replace the cached transcript once. `spokenLanguage` marks the attempt so
 *  a track that keeps failing to download does not cause a refetch on every open. */
function wrongCachedTrack(meta: VideoMeta, rec: EpisodeRecord): boolean {
  if (rec.manualTrack) return false;
  if (rec.source !== 'official' && rec.source !== 'youtube-auto') return false;
  const spoken = meta.originalLanguage ? langRoot(meta.originalLanguage) : '';
  if (!spoken || langRoot(rec.language) === spoken) return false;
  // Auto captions in another language do not match the audio, even if no other track exists:
  // never keep such a cached transcript in front of the viewer.
  if (rec.source === 'youtube-auto') return true;
  if (rec.spokenLanguage === spoken) return false;
  return meta.tracks.some((t) => langRoot(t.language) === spoken);
}

/** A shared transcript in the wrong language hides the track in the language being spoken. */
function wrongSharedLanguage(meta: VideoMeta, hit: SharedTranscript): boolean {
  const spoken = meta.originalLanguage ? langRoot(meta.originalLanguage) : '';
  if (!spoken || langRoot(hit.language) === spoken) return false;
  return meta.tracks.some((t) => langRoot(t.language) === spoken);
}

/** Keys this episode can be looked up by: the extension's own key plus the desktop app's RSS keys
 *  (`guid:`, `audio:`), so either client finds a transcript the other shared. */
function metaKeys(meta: VideoMeta): string[] {
  return [...new Set([EPISODE_KEY(meta.videoId), ...(meta.sharedKeys ?? [])])];
}

function recordKeys(rec: EpisodeRecord | null, videoId: string): string[] {
  return [...new Set([EPISODE_KEY(videoId), ...(rec?.sharedKeys ?? [])])];
}

/** Apple and Ximalaya pages do not expose the episode's audio file. Fill it in from their public
 *  catalogue and push the filled metadata to the panel before any status that depends on it. */
async function resolvePodcastForTab(tabId: number, meta: VideoMeta): Promise<VideoMeta> {
  try {
    const resolved = await resolvePodcastEpisode(meta);
    if (!resolved) return meta;
    const { episode, sharedKeys } = resolved;
    const merged: VideoMeta = {
      ...meta,
      title: episode.title || meta.title,
      channel: episode.channel || meta.channel,
      duration: episode.duration || meta.duration,
      audioUrl: episode.audioUrl,
      sharedKeys,
    };
    const st = tabStates.get(tabId);
    if (st && st.videoId === meta.videoId) {
      st.meta = st.meta ? { ...st.meta, ...merged } : merged;
      if (merged.duration) st.duration = merged.duration;
      tabStates.set(tabId, st);
      broadcastSnapshot(tabId);
    }
    return merged;
  } catch (e) {
    log('podcast resolve failed', meta.site, meta.videoId, e);
    return meta;
  }
}

function ensureEpisode(tabId: number, meta: VideoMeta, force = false): Promise<void> {
  const key = EPISODE_KEY(meta.videoId);
  const running = pipelineRuns.get(key);
  if (running) return running;
  const run = (async () => {
    const settings = await getSettings();
    const cached = await getEpisode(key);
    if (cached && cached.segments.length && !force && !wrongCachedTrack(meta, cached)) {
      notifyEpisode(tabId, cached);
      if (!maybeAutoTranslate(tabId, cached, settings.autoTranslate)) void maybePunctuate(cached);
      return;
    }
    if (meta.site === 'spotify') {
      // DRM: no audio the extension could download, and no shared library key for it.
      setStatus(tabId, { state: 'unsupported', message: SPOTIFY_DRM_NOTICE });
      return;
    }
    const podcast = isPodcastSite(meta.site);
    let current = meta;
    if (podcast && !current.audioUrl) {
      setStatus(tabId, { state: 'loading', step: '读取节目信息…' });
      current = await resolvePodcastForTab(tabId, current);
    }
    setStatus(tabId, { state: 'loading', step: settings.useShared ? '查询共享字幕' : podcast ? '准备生成字幕' : '获取 YouTube 字幕' });
    if (settings.useShared) {
      const hit = await lookupTranscript(metaKeys(current));
      if (hit && !wrongSharedLanguage(current, hit)) {
        const rec = recordFromShared(current, hit);
        await putEpisode(rec);
        notifyEpisode(tabId, rec);
        log('shared hit', key, hit.source, hit.segments.length);
        if (!maybeAutoTranslate(tabId, rec, settings.autoTranslate)) void maybePunctuate(rec);
        return;
      }
    }
    if (podcast) {
      // Podcasts have no caption tracks: the episode's own transcript comes from cloud ASR,
      // started by the user because it costs money and uploads audio to their provider.
      if (!current.audioUrl) setStatus(tabId, { state: 'error', message: podcastUnavailableMessage(current.site) });
      else setStatus(tabId, { state: 'no-captions' });
      return;
    }
    setStatus(tabId, { state: 'loading', step: '获取 YouTube 字幕' });
    let currentMeta = meta;
    let segments = await fetchFromTracks(currentMeta);
    if (
      (!segments.segments.length || autoCaptionsMismatch(segments.language, segments.auto, currentMeta.originalLanguage)) &&
      currentMeta.origin === 'page'
    ) {
      // Caption URLs from the watch page can go stale; ask InnerTube while we are at it. A fresh
      // response may also list an audio-language track the watch page did not include.
      const fresh = await fetchInnerTubeMeta(meta.videoId, meta.url);
      if (fresh) {
        currentMeta = {
          ...currentMeta,
          ...fresh,
          tracks: fresh.tracks.length ? fresh.tracks : currentMeta.tracks,
          audio: fresh.audio.length ? fresh.audio : currentMeta.audio,
          originalLanguage: fresh.originalLanguage ?? currentMeta.originalLanguage,
          title: fresh.title || currentMeta.title,
          channel: fresh.channel || currentMeta.channel,
          duration: fresh.duration || currentMeta.duration,
        };
        const st = tabStates.get(tabId);
        if (st && st.videoId === meta.videoId) {
          st.meta = currentMeta;
          tabStates.set(tabId, st);
          broadcastSnapshot(tabId);
        }
        segments = await fetchFromTracks(currentMeta);
      }
    }
    if (!segments.segments.length) {
      if (currentMeta.tracks.length || segments.tried) {
        setStatus(tabId, { state: 'error', message: '字幕下载失败，可能是网络或 YouTube 限制。可以刷新页面重试。' });
      } else {
        setStatus(tabId, { state: 'no-captions' });
      }
      return;
    }
    if (autoCaptionsMismatch(segments.language, segments.auto, currentMeta.originalLanguage)) {
      // The audio is Chinese but YouTube only offers English auto captions (or the reverse): the
      // text does not match the speech, so generate a transcript from the audio instead.
      await cloudForMismatchedCaptions(tabId, currentMeta, segments.language);
      return;
    }
    const rec: EpisodeRecord = {
      key,
      videoId: meta.videoId,
      title: currentMeta.title || meta.title,
      channel: currentMeta.channel || meta.channel,
      duration: currentMeta.duration || meta.duration,
      language: segments.language,
      spokenLanguage: currentMeta.originalLanguage,
      source: segments.auto ? 'youtube-auto' : 'official',
      segments: segments.segments,
      translation: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await putEpisode(rec);
    notifyEpisode(tabId, rec);
    log('captions', key, rec.source, rec.segments.length);
    if (!maybeAutoTranslate(tabId, rec, settings.autoTranslate)) void maybePunctuate(rec);
  })().catch((e) => {
    log('pipeline failed', e);
    setStatus(tabId, { state: 'error', message: e instanceof Error ? e.message : String(e) });
  }).finally(() => {
    pipelineRuns.delete(key);
  });
  pipelineRuns.set(key, run);
  return run;
}

/** The only captions YouTube offers are auto-generated in a language that is not spoken in the
 *  video. Showing them would put the wrong text under the audio, so use the same cloud ASR path as
 *  a video without captions; if no ASR key is configured, say why the captions were ignored. */
async function cloudForMismatchedCaptions(tabId: number, meta: VideoMeta, captionLanguage: string): Promise<void> {
  const settings = await getSettings();
  const spoken = meta.originalLanguage ? langRoot(meta.originalLanguage) : '';
  if (settings.asrEngine !== 'off' && settings.asrKey.trim()) {
    const message = `YouTube 只有 ${captionLanguage.toUpperCase()} 自动字幕，和视频语音不一致，正在用云端识别生成字幕`;
    log('auto captions mismatch, cloud asr', meta.videoId, captionLanguage, spoken);
    broadcast({ type: 'TOAST', kind: 'info', message });
    setStatus(tabId, { state: 'loading', step: '自动字幕和语音不一致，改用云端识别…' });
    await startAsr(tabId, meta);
    return;
  }
  broadcast({
    type: 'TOAST',
    kind: 'info',
    message: `YouTube 只有 ${captionLanguage.toUpperCase()} 自动字幕，和视频语音不一致；配置云端识别后可以按语音生成字幕`,
  });
  setStatus(tabId, { state: 'no-captions', mismatch: { spoken, found: captionLanguage } });
}

async function fetchFromTracks(meta: VideoMeta): Promise<{ segments: EpisodeRecord['segments']; language: string; auto: boolean; tried: boolean }> {
  const candidates = chooseTrack(meta.tracks, meta.originalLanguage, meta.title);
  const ordered = candidates ? [candidates, ...meta.tracks.filter((t) => t !== candidates)].slice(0, 3) : [];
  let tried = false;
  for (const track of ordered) {
    tried = true;
    const raw = await fetchTrackSegments(track);
    if (raw.length) {
      const segments = resegment(clean(raw));
      if (segments.length) return { segments, language: track.language, auto: track.auto, tried };
    }
  }
  return { segments: [], language: 'en', auto: false, tried };
}

/** Fetches the caption track the user picked by hand and makes it the episode's transcript. */
async function loadTrack(tabId: number, videoId: string, track: CaptionTrack): Promise<void> {
  const key = EPISODE_KEY(videoId);
  const running = pipelineRuns.get(key);
  if (running) await running.catch(() => {});
  setStatus(tabId, { state: 'loading', step: '获取所选字幕' });
  try {
    const raw = await fetchTrackSegments(track);
    const segments = resegment(clean(raw));
    if (!segments.length) throw new Error('这条字幕下载失败，换一条试试。');
    if (translating.has(videoId) || punctuating.has(videoId)) {
      translating.delete(videoId);
      punctuating.delete(videoId);
      try {
        await ensureOffscreen();
        await sendOffscreen({ type: 'OFFSCREEN_CANCEL', videoId });
      } catch {
        /* no offscreen job to cancel */
      }
    }
    const prev = await getEpisode(key);
    const meta = findVideoState(videoId)?.meta;
    const rec: EpisodeRecord = {
      key,
      videoId,
      title: prev?.title || meta?.title || '',
      channel: prev?.channel || meta?.channel || '',
      duration: prev?.duration || meta?.duration || 0,
      language: track.language,
      spokenLanguage: meta?.originalLanguage,
      manualTrack: true,
      source: track.auto ? 'youtube-auto' : 'official',
      segments,
      translation: null,
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await putEpisode(rec);
    notifyEpisode(tabId, rec);
    log('manual track', key, track.language, rec.segments.length);
    const settings = await getSettings();
    if (!maybeAutoTranslate(tabId, rec, settings.autoTranslate)) void maybePunctuate(rec);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(tabId, { state: 'error', message });
    broadcast({ type: 'TOAST', kind: 'error', message });
  }
}

function recordFromShared(meta: VideoMeta, hit: SharedTranscript): EpisodeRecord {
  const n = hit.segments.length;
  const items = hit.translation ? normalizeItems(hit.translation.items, n) : null;
  const status =
    items && items.some((x) => x != null) && items.some((x, i) => x == null && hit.segments[i].text.trim() !== '')
      ? 'partial'
      : 'done';
  return {
    key: EPISODE_KEY(meta.videoId),
    videoId: meta.videoId,
    title: meta.title,
    channel: meta.channel,
    duration: meta.duration,
    language: hit.language,
    source: 'shared',
    sharedSource: hit.source,
    sharedKeys: meta.sharedKeys,
    segments: hit.segments,
    translation: items
      ? {
          lang: hit.translation?.lang || 'zh-CN',
          engine: hit.translation?.engine === 'llm' ? 'llm' : 'google',
          model: hit.translation?.model ?? '',
          items,
          status,
          updatedAt: Date.now(),
        }
      : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeItems(items: (string | null)[], n: number): (string | null)[] {
  const out = items.slice(0, n);
  while (out.length < n) out.push(null);
  return out;
}

function notifyEpisode(tabId: number, rec: EpisodeRecord) {
  revision++;
  const st = tabStates.get(tabId);
  if (!st || st.videoId !== rec.videoId) return;
  if (st.status.state !== 'translating') st.status = { state: 'ready' };
  tabStates.set(tabId, st);
  broadcastSnapshot(tabId);
  broadcast({ type: 'EPISODE_UPDATED', videoId: rec.videoId, revision });
  scheduleSubtitles(tabId);
}

/** Starts auto-translation when it is still needed; returns whether a translation job was started. */
function maybeAutoTranslate(tabId: number, rec: EpisodeRecord, auto: boolean): boolean {
  if (!auto) return false;
  if (!shouldTranslate(rec.language)) return false;
  if (!needsTranslation(rec.translation?.items ?? [], rec.segments)) return false;
  void startTranslate(tabId, rec).catch((e) => log('translate start failed', e));
  return true;
}

/** Chinese transcript punctuation. For a Chinese video the source captions are what the user reads,
 *  so they are punctuated directly; other languages punctuate the Chinese translation instead. */
async function maybePunctuate(rec: EpisodeRecord): Promise<void> {
  const target: 'segments' | 'translation' = shouldTranslate(rec.language) ? 'translation' : 'segments';
  if (target === 'segments') {
    if (rec.punctuatedAt) return;
    if (!punctuationTargets(rec.segments, segmentTexts(rec.segments)).length) return;
  } else {
    const translation = rec.translation;
    if (!translation || translation.punctuatedAt) return;
    if (!punctuationTargets(rec.segments, translation.items).length) return;
  }
  if (punctuating.has(rec.videoId) || translating.has(rec.videoId)) return;
  const settings = await getSettings();
  if (!settings.autoPunctuate || !llmReady(settings.llm)) return;
  if (punctuating.has(rec.videoId) || translating.has(rec.videoId)) return;
  punctuating.add(rec.videoId);
  try {
    await ensureOffscreen();
    await sendOffscreen({ type: 'OFFSCREEN_PUNCTUATE', videoId: rec.videoId, llm: settings.llm, target });
  } catch (e) {
    punctuating.delete(rec.videoId);
    log('punctuate start failed', e);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Translation                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

async function startTranslate(tabId: number, rec: EpisodeRecord): Promise<void> {
  const videoId = rec.videoId;
  if (translating.has(videoId)) return;
  if (!shouldTranslate(rec.language)) {
    setStatus(tabId, { state: 'ready' });
    return;
  }
  const settings = await getSettings();
  const useLlm = settings.translateEngine === 'llm' && llmReady(settings.llm);
  if (settings.translateEngine === 'llm' && !llmReady(settings.llm)) {
    broadcast({ type: 'TOAST', kind: 'info', message: '模型翻译还没配置好，已改用谷歌翻译' });
  }
  translating.add(videoId);
  const total = rec.segments.length;
  setStatusForVideo(videoId, { state: 'translating', done: 0, total });
  broadcast({ type: 'TRANSLATE_PROGRESS', videoId, done: 0, total });
  try {
    await ensureOffscreen();
    await sendOffscreen({
      type: 'OFFSCREEN_TRANSLATE',
      videoId,
      engine: useLlm ? 'llm' : 'google',
      llm: settings.llm,
      title: rec.title,
      show: rec.channel,
    });
  } catch (e) {
    translating.delete(videoId);
    const message = e instanceof Error ? e.message : String(e);
    setStatusForVideo(videoId, { state: 'error', message: `翻译失败：${message}` });
    broadcast({ type: 'TOAST', kind: 'error', message: `翻译失败：${message}` });
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Cloud ASR                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

async function startAsr(tabId: number, meta: VideoMeta): Promise<void> {
  const videoId = meta.videoId;
  if (asrJobs.has(videoId)) return;
  const settings = await getSettings();
  if (settings.asrEngine === 'off' || !settings.asrKey.trim()) {
    const message = '没有配置云端识别。请在设置 › 云端识别里选择 Groq 或 OpenAI 并填写 Key。';
    setStatus(tabId, { state: 'error', message });
    broadcast({ type: 'ASR_ERROR', videoId, message });
    return;
  }
  asrJobs.add(videoId);
  try {
    const podcast = isPodcastSite(meta.site);
    let current = meta;
    let audioUrl = podcast ? meta.audioUrl : bestAudio(current.audio)?.url;
    if (podcast && !audioUrl) {
      setStatus(tabId, { state: 'loading', step: '读取节目信息…' });
      current = await resolvePodcastForTab(tabId, meta);
      audioUrl = current.audioUrl;
    }
    if (!audioUrl && !podcast) {
      const fresh = await fetchInnerTubeMeta(videoId, meta.url);
      if (fresh) {
        current = { ...current, ...fresh, audio: fresh.audio, tracks: fresh.tracks.length ? fresh.tracks : current.tracks };
        const st = tabStates.get(tabId);
        if (st) {
          st.meta = current;
          tabStates.set(tabId, st);
          broadcastSnapshot(tabId);
        }
        audioUrl = bestAudio(current.audio)?.url;
      }
    }
    if (!audioUrl) {
      throw new Error(
        podcast
          ? podcastUnavailableMessage(current.site)
          : '拿不到这个视频的音频流（可能是直播、会员或受限制的视频），无法识别。',
      );
    }
    // The offscreen document decodes the whole file into memory; cap very long episodes.
    if (podcast && current.duration > 3 * 3600) throw new Error('这期节目超过 3 小时，浏览器里解码会占用过多内存，暂时无法识别。');
    const preset = ASR_PRESETS[settings.asrEngine === 'openai' ? 'openai' : 'groq'];
    const model = settings.asrModel.trim() || preset.model;
    setStatus(tabId, { state: 'loading', step: '下载音频…' });
    broadcast({ type: 'ASR_PROGRESS', videoId, stage: 'download', percent: 0, message: '开始下载音频' });
    await ensureOffscreen();
    await sendOffscreen({
      type: 'OFFSCREEN_ASR',
      videoId,
      audioUrl,
      provider: settings.asrEngine === 'openai' ? 'openai' : 'groq',
      apiKey: settings.asrKey,
      model,
      language: settings.asrLanguage,
      meta: { title: current.title, channel: current.channel, duration: current.duration },
      sharedKeys: current.sharedKeys,
    });
  } catch (e) {
    asrJobs.delete(videoId);
    const message = e instanceof Error ? e.message : String(e);
    setStatus(tabId, { state: 'error', message: `云端识别失败：${message}` });
    broadcast({ type: 'ASR_ERROR', videoId, message });
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Guide                                                                                            */
/* ------------------------------------------------------------------------------------------------ */


async function lookupGuideForPanel(port: chrome.runtime.Port, videoId: string): Promise<void> {
  const key = EPISODE_KEY(videoId);
  try {
    const cached = await getGuide(key);
    if (cached) {
      safePost(port, { type: 'GUIDE', videoId, text: cached.text, source: cached.source === 'shared' ? 'shared' : 'cache', model: cached.model });
      return;
    }
    const settings = await getSettings();
    if (settings.useShared) {
      const rec = await getEpisode(key);
      const hit = await lookupGuide(recordKeys(rec, videoId));
      if (hit) {
        await putGuide({ key, text: hit.text, model: 'shared', source: 'shared', createdAt: hit.createdAt ?? Date.now() });
        safePost(port, { type: 'GUIDE', videoId, text: hit.text, source: 'shared' });
        return;
      }
    }
    safePost(port, { type: 'GUIDE_NONE', videoId });
  } catch {
    safePost(port, { type: 'GUIDE_NONE', videoId });
  }
}

async function generateGuide(port: chrome.runtime.Port, videoId: string, force: boolean): Promise<void> {
  const key = EPISODE_KEY(videoId);
  try {
    if (guideJobs.has(videoId)) throw new Error('导读正在生成，请稍等');
    const ep = await getEpisode(key);
    if (!ep) throw new Error('还没有字幕，无法生成导读');
    if (!force) {
      const cached = await getGuide(key);
      if (cached) {
        safePost(port, { type: 'GUIDE', videoId, text: cached.text, source: cached.source === 'shared' ? 'shared' : 'cache', model: cached.model });
        return;
      }
    }
    const settings = await getSettings();
    if (settings.useShared) {
      const hit = await lookupGuide(recordKeys(ep, videoId));
      if (hit) {
        await putGuide({ key, text: hit.text, model: 'shared', source: 'shared', createdAt: hit.createdAt ?? Date.now() });
        safePost(port, { type: 'GUIDE', videoId, text: hit.text, source: 'shared' });
        return;
      }
    }
    if (!llmReady(settings.llm)) throw new Error('生成导读需要模型服务。请到设置里填写 DeepSeek（或其他 OpenAI 兼容服务）的 Key。');
    guideJobs.add(videoId);
    const transcript = transcriptForModel(ep.segments, ep.translation?.items);
    const text = await llmChat(settings.llm, {
      system: GUIDE_SYSTEM,
      messages: [{ role: 'user', content: `${guidePrompt(ep.duration)}\n\n<transcript>\n${transcript}\n</transcript>` }],
      maxTokens: 8000,
      temperature: 0.3,
      timeoutMs: 300_000,
    });
    await putGuide({ key, text, model: settings.llm.model, source: 'llm', createdAt: Date.now() });
    safePost(port, { type: 'GUIDE', videoId, text, source: 'llm', model: settings.llm.model });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    safePost(port, { type: 'GUIDE_ERROR', videoId, message: isKeyError(message) ? `${message}（请检查设置里的 Key）` : message });
  } finally {
    guideJobs.delete(videoId);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Q&A                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

async function handleChat(
  port: chrome.runtime.Port,
  msg: Extract<PanelRequest, { type: 'CHAT' }>,
): Promise<void> {
  const { requestId, videoId, question, history } = msg;
  const controller = new AbortController();
  chatJobs.set(requestId, controller);
  const finish = () => {
    chatJobs.delete(requestId);
    panelChats.get(port)?.delete(requestId);
  };
  try {
    const settings = await getSettings();
    if (!llmReady(settings.llm)) throw new Error('AI 问答需要模型服务。请到设置里填写 DeepSeek（或其他 OpenAI 兼容服务）的 Key。');
    const ep = await getEpisode(EPISODE_KEY(videoId));
    if (!ep) throw new Error('还没有字幕，无法问答');
    const transcript = transcriptForModel(ep.segments, ep.translation?.items);
    let full = '';
    await llmChat(settings.llm, {
      system: qaSystem(ep.title, ep.channel, transcript),
      messages: [
        ...history.slice(-10).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: question },
      ],
      maxTokens: 4000,
      temperature: 0.3,
      signal: controller.signal,
      onDelta: (text) => {
        full += text;
        safePost(port, { type: 'CHAT_DELTA', requestId, text });
      },
    });
    safePost(port, { type: 'CHAT_DONE', requestId, text: full, model: settings.llm.model });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      safePost(port, { type: 'CHAT_ERROR', requestId, message: '已停止回答' });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      safePost(port, { type: 'CHAT_ERROR', requestId, message: isKeyError(message) ? `${message}（请检查设置里的 Key）` : message });
    }
  } finally {
    finish();
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Offscreen document                                                                               */
/* ------------------------------------------------------------------------------------------------ */

let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    if (!chrome.offscreen?.hasDocument) throw new Error('当前 Chrome 版本不支持 offscreen，请升级浏览器');
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: '整集字幕翻译和云端识别的长任务，避免 service worker 被浏览器回收',
    });
    // Give the document a moment to register its listener.
    await new Promise((r) => setTimeout(r, 200));
  })().catch((e) => {
    offscreenReady = null;
    throw e;
  });
  return offscreenReady;
}

async function sendOffscreen(msg: OffscreenRequest): Promise<void> {
  await chrome.runtime.sendMessage(msg);
}

async function handleOffscreenEvent(msg: OffscreenEvent): Promise<void> {
  if (msg.type === 'TR_PROGRESS') {
    // The offscreen document owns the partial translation writes; here we only fan out progress.
    revision++;
    broadcast({ type: 'TRANSLATE_PROGRESS', videoId: msg.videoId, done: msg.done, total: msg.total });
    setStatusForVideo(msg.videoId, { state: 'translating', done: msg.done, total: msg.total });
    const st = findVideoState(msg.videoId);
    if (st) scheduleSubtitles(st.tabId);
    return;
  }
  if (msg.type === 'TR_DONE') {
    translating.delete(msg.videoId);
    const rec = await getEpisode(EPISODE_KEY(msg.videoId));
    if (rec) {
      revision++;
      setStatusForVideo(msg.videoId, { state: 'ready' });
      broadcast({ type: 'EPISODE_UPDATED', videoId: msg.videoId, revision });
      const st = findVideoState(msg.videoId);
      if (st) scheduleSubtitles(st.tabId);
      if (rec.source === 'cloud') void maybeUpload(rec);
      void maybePunctuate(rec);
    }
    return;
  }
  if (msg.type === 'TR_CANCELLED') {
    translating.delete(msg.videoId);
    setStatusForVideo(msg.videoId, { state: 'ready' });
    return;
  }
  if (msg.type === 'TR_ERROR') {
    translating.delete(msg.videoId);
    setStatusForVideo(msg.videoId, { state: 'error', message: `翻译失败：${msg.message}` });
    broadcast({ type: 'TOAST', kind: 'error', message: `翻译失败：${msg.message}` });
    return;
  }
  if (msg.type === 'ASR_PROGRESS') {
    setStatusForVideo(msg.videoId, { state: 'loading', step: msg.message || '云端识别…' });
    broadcast({ type: 'ASR_PROGRESS', videoId: msg.videoId, stage: msg.stage, percent: msg.percent, message: msg.message });
    return;
  }
  if (msg.type === 'ASR_DONE') {
    asrJobs.delete(msg.videoId);
    const rec = await getEpisode(EPISODE_KEY(msg.videoId));
    if (rec) {
      notifyEpisodeForVideo(rec);
      const settings = await getSettings();
      broadcast({ type: 'ASR_DONE', videoId: msg.videoId });
      if (settings.autoTranslate && shouldTranslate(rec.language)) {
        const st = findVideoState(msg.videoId);
        if (st) void startTranslate(st.tabId, rec);
        else void startTranslateForVideo(rec);
      } else if (settings.shareTranscripts) {
        void maybeUpload(rec);
      }
      void maybePunctuate(rec);
    }
    return;
  }
  if (msg.type === 'ASR_ERROR') {
    asrJobs.delete(msg.videoId);
    setStatusForVideo(msg.videoId, { state: 'error', message: `云端识别失败：${msg.message}` });
    broadcast({ type: 'ASR_ERROR', videoId: msg.videoId, message: msg.message });
    return;
  }
  if (msg.type === 'PU_PROGRESS') {
    revision++;
    broadcast({ type: 'EPISODE_UPDATED', videoId: msg.videoId, revision });
    const st = findVideoState(msg.videoId);
    if (st) scheduleSubtitles(st.tabId);
    return;
  }
  if (msg.type === 'PU_DONE') {
    punctuating.delete(msg.videoId);
    revision++;
    broadcast({ type: 'EPISODE_UPDATED', videoId: msg.videoId, revision });
    const st = findVideoState(msg.videoId);
    if (st) scheduleSubtitles(st.tabId);
    log('punctuation', msg.videoId, `${msg.changed}/${msg.total}`);
    return;
  }
  if (msg.type === 'PU_CANCELLED') {
    punctuating.delete(msg.videoId);
    return;
  }
  if (msg.type === 'PU_ERROR') {
    punctuating.delete(msg.videoId);
    log('punctuation failed', msg.videoId, msg.message);
  }
}

function notifyEpisodeForVideo(rec: EpisodeRecord) {
  revision++;
  const st = findVideoState(rec.videoId);
  if (st) {
    st.status = { state: 'ready' };
    tabStates.set(st.tabId, st);
    if (st.tabId === activeTabId) broadcastSnapshot();
    scheduleSubtitles(st.tabId);
  }
  broadcast({ type: 'EPISODE_UPDATED', videoId: rec.videoId, revision });
}

async function startTranslateForVideo(rec: EpisodeRecord) {
  // No tab currently shows this video (the user navigated away); translation can still run and cache.
  const settings = await getSettings();
  if (!settings.autoTranslate || !shouldTranslate(rec.language)) return;
  if (translating.has(rec.videoId)) return;
  if (!needsTranslation(rec.translation?.items ?? [], rec.segments)) return;
  const useLlm = settings.translateEngine === 'llm' && llmReady(settings.llm);
  translating.add(rec.videoId);
  try {
    await ensureOffscreen();
    await sendOffscreen({
      type: 'OFFSCREEN_TRANSLATE',
      videoId: rec.videoId,
      engine: useLlm ? 'llm' : 'google',
      llm: settings.llm,
      title: rec.title,
      show: rec.channel,
    });
  } catch (e) {
    translating.delete(rec.videoId);
    log('translate failed', e);
  }
}

async function maybeUpload(rec: EpisodeRecord): Promise<void> {
  if (rec.source !== 'cloud' || rec.uploadedAt) return;
  const settings = await getSettings();
  if (!settings.shareTranscripts || !settings.installId) return;
  if (uploading.has(rec.videoId)) return;
  uploading.add(rec.videoId);
  try {
    const out = await uploadTranscript(rec, { installId: settings.installId, appVersion: APP_VERSION });
    if (out) {
      await updateEpisode(rec.key, (cur) => ({ ...cur, uploadedAt: Date.now(), updatedAt: Date.now() }));
      broadcast({ type: 'TOAST', kind: 'info', message: `字幕已共享给其他人（${out.action || 'ok'}）` });
    }
  } finally {
    uploading.delete(rec.videoId);
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Subtitles to the page overlay                                                                    */
/* ------------------------------------------------------------------------------------------------ */

function scheduleSubtitles(tabId: number) {
  if (subtitleTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    subtitleTimers.delete(tabId);
    void pushSubtitles(tabId);
  }, 350);
  subtitleTimers.set(tabId, timer);
}

async function pushSubtitles(tabId: number): Promise<void> {
  const st = tabStates.get(tabId);
  if (!st?.videoId) return;
  const rec = await getEpisode(EPISODE_KEY(st.videoId));
  if (!rec) return;
  const settings = await getSettings();
  const msg = {
    type: 'SUBTITLES',
    videoId: rec.videoId,
    key: rec.key,
    segments: rec.segments,
    items: rec.translation?.items ?? null,
    source: rec.source,
    sharedSource: rec.sharedSource,
    language: rec.language,
    mode: settings.displayMode,
    overlay: settings.overlay,
    overlayMode: settings.overlayMode,
  };
  await sendToContent(tabId, msg);
}

/* ------------------------------------------------------------------------------------------------ */
/* Boot                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export default defineBackground(() => {
  log('background started', APP_VERSION);

  chrome.runtime.onInstalled.addListener(() => {
    void getSettings();
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => {
    void getSettings();
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  });
  void getSettings();
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

  chrome.action?.onClicked?.addListener((tab) => {
    if (tab.id != null) void chrome.sidePanel?.open?.({ tabId: tab.id }).catch(() => {});
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'subcast-content') onContentPort(port);
    else if (port.name === 'subcast-panel') onPanelPort(port);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.type) return false;
    if (msg.type === 'TR_PROGRESS' || msg.type === 'TR_DONE' || msg.type === 'TR_ERROR' || msg.type === 'TR_CANCELLED' || msg.type === 'ASR_PROGRESS' || msg.type === 'ASR_DONE' || msg.type === 'ASR_ERROR' || msg.type === 'PU_PROGRESS' || msg.type === 'PU_DONE' || msg.type === 'PU_ERROR' || msg.type === 'PU_CANCELLED') {
      void handleOffscreenEvent(msg as OffscreenEvent);
      return false;
    }
    if (msg.type === 'OFFSCREEN_READY') {
      offscreenReady = Promise.resolve();
      return false;
    }
    if (msg.type === 'TEST_LLM') {
      void (async () => {
        try {
          const text = await llmChat(msg.llm, {
            system: 'You are a connection test. Reply with exactly: OK',
            messages: [{ role: 'user', content: 'ping' }],
            maxTokens: 16,
            temperature: 0,
            timeoutMs: 30_000,
          });
          sendResponse({ ok: true, message: text.trim().slice(0, 80) });
        } catch (e) {
          sendResponse({ ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }
    if (sender.tab) {
      handleContentRequest(msg as ContentRequest, sender);
      return false;
    }
    return false;
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    activeTabId = tabId;
    void (async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) ensureTab(tabId, tab.url ?? '');
      broadcastSnapshot();
      if (!tabStates.get(tabId)?.meta) await sendToContent(tabId, { type: 'RESYNC' });
    })();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabStates.delete(tabId);
    contentPorts.delete(tabId);
    const timer = subtitleTimers.get(tabId);
    if (timer) clearTimeout(timer);
    subtitleTimers.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
  });

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url && tab.url) {
      const st = ensureTab(tabId, tab.url);
      if (tabId === activeTabId) broadcastSnapshot();
      if (!videoIdFromUrl(tab.url)) {
        st.videoId = null;
        st.meta = null;
        st.status = { state: 'idle' };
        tabStates.set(tabId, st);
      }
    }
  });

  onSettingsChanged((s) => {
    void (async () => {
      for (const tabId of tabStates.keys()) await sendSettingsToContent(tabId);
      for (const tabId of tabStates.keys()) scheduleSubtitles(tabId);
      if (s.overlay != null) broadcastSnapshot();
      // Turning the option on while a video is open should punctuate what is already translated.
      if (s.autoPunctuate) {
        for (const st of tabStates.values()) {
          if (!st.videoId) continue;
          const rec = await getEpisode(EPISODE_KEY(st.videoId));
          if (rec) void maybePunctuate(rec);
        }
      }
    })();
  });
});
