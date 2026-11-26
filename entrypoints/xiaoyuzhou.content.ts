/** Xiaoyuzhou (小宇宙) episode pages. There are no subtitle tracks to download: the side panel asks
 *  for cloud ASR, so this script only reports the episode's metadata and the audio playback state,
 *  and lets the panel seek the page's own player. */
import type { ContentEvent } from '../src/lib/messages';
import type { VideoMeta } from '../src/lib/types';
import { episodeIdFromUrl, episodeMetaFromHtml, episodeMetaFromNextData } from '../src/lib/xiaoyuzhou';

const BTN_CSS = `
  :host { all: initial; }
  .btn {
    display: flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
    padding: 7px 12px; border-radius: 999px; color: #fff; background: rgba(17, 17, 20, .92);
    font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .3);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
  .btn:hover { background: rgba(30, 30, 36, .98); }
`;

let port: chrome.runtime.Port | null = null;
let currentId: string | null = null;
let meta: VideoMeta | null = null;
let entering = 0;
let button: HTMLDivElement | null = null;

/** The site renders a hidden trial-end cue as a second `<audio>`; use the episode one. */
function mainAudio(): HTMLAudioElement | null {
  const list = Array.from(document.querySelectorAll('audio'));
  return list.find((a) => a.src && !a.src.includes('/static/audio/')) ?? list[0] ?? null;
}

function fallbackMeta(eid: string): VideoMeta {
  const audio = mainAudio();
  const src = audio?.src || audio?.currentSrc || '';
  return {
    videoId: `qm:${eid}`,
    title: document.title.replace(/\s*[|｜]\s*小宇宙.*$/, '').trim(),
    channel: '',
    duration: Number.isFinite(audio?.duration) ? audio!.duration : 0,
    url: location.href,
    tracks: [],
    audio: [],
    audioUrl: /^https?:\/\//.test(src) ? src : undefined,
    site: 'xiaoyuzhou',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

async function resolveMeta(eid: string): Promise<VideoMeta> {
  const el = document.getElementById('__NEXT_DATA__');
  if (el?.textContent) {
    try {
      const m = episodeMetaFromNextData(JSON.parse(el.textContent), location.href);
      if (m?.videoId === `qm:${eid}`) return m;
    } catch {
      /* fall through to a fresh page fetch */
    }
  }
  // In-page navigation keeps the first page's JSON; fetch this episode's server-rendered page.
  try {
    const res = await fetch(location.href, { credentials: 'same-origin', signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const m = episodeMetaFromHtml(await res.text(), location.href);
      if (m?.videoId === `qm:${eid}`) return m;
    }
  } catch {
    /* use what the DOM tells us */
  }
  return fallbackMeta(eid);
}

function sendMeta() {
  if (!meta) return;
  try {
    port?.postMessage({ type: 'META', meta });
  } catch {
    /* reconnect will resend */
  }
}

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'subcast-content' });
  } catch {
    port = null;
    setTimeout(connect, 1500);
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1200);
  });
  if (meta) sendMeta();
  sendState();
}

function sendState() {
  if (!currentId || !port) return;
  const audio = mainAudio();
  try {
    port.postMessage({
      type: 'STATE',
      videoId: currentId,
      time: audio?.currentTime || 0,
      duration: Number.isFinite(audio?.duration) ? audio!.duration : meta?.duration || 0,
      paused: audio?.paused ?? true,
    });
  } catch {
    /* port closing */
  }
}

function ensureButton() {
  if (button?.isConnected) return;
  button = document.createElement('div');
  button.id = 'subcast-panel-host';
  button.style.cssText = 'position:fixed;right:20px;bottom:96px;z-index:2147483646;';
  const shadow = button.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${BTN_CSS}</style><button class="btn" type="button" title="打开 SubCast 侧边栏"><span class="dot"></span>声渡</button>`;
  shadow.querySelector('button')?.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }).catch(() => {});
    } catch {
      /* worker starting */
    }
  });
  (document.body ?? document.documentElement).appendChild(button);
}

function removeButton() {
  button?.remove();
  button = null;
}

async function enterEpisode(eid: string) {
  const token = ++entering;
  currentId = `qm:${eid}`;
  meta = null;
  ensureButton();
  const next = await resolveMeta(eid);
  if (token !== entering || currentId !== `qm:${eid}`) return;
  meta = next;
  sendMeta();
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY', videoId: currentId, url: location.href }).catch(() => {});
  } catch {
    /* worker starting */
  }
  sendState();
}

function leaveEpisode() {
  entering++;
  currentId = null;
  meta = null;
  removeButton();
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY', videoId: null, url: location.href }).catch(() => {});
  } catch {
    /* worker starting */
  }
}

function onRuntimeMessage(msg: ContentEvent) {
  if (msg.type === 'SEEK') {
    const audio = mainAudio();
    if (!audio) return;
    audio.currentTime = Math.max(0, msg.seconds);
    if (audio.paused) void audio.play().catch(() => {});
    return;
  }
  if (msg.type === 'RESYNC' && meta) sendMeta();
}

export default defineContentScript({
  matches: ['https://www.xiaoyuzhoufm.com/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    connect();

    // The site is a Next.js app: episode -> episode navigation does not reload the page.
    setInterval(() => {
      const eid = episodeIdFromUrl(location.href);
      const want = eid ? `qm:${eid}` : null;
      if (want === currentId) return;
      if (want) void enterEpisode(eid!);
      else leaveEpisode();
    }, 500);

    setInterval(sendState, 250);

    const eid = episodeIdFromUrl(location.href);
    if (eid) void enterEpisode(eid);
  },
});
