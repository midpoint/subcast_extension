/** Long jobs live here so the MV3 service worker can be recycled safely: batched translation,
 *  cloud ASR (audio download, Web Audio decode, WAV chunking, upload). The document has IndexedDB
 *  and the extension origin, so host permissions still apply to its fetches. */
import { transcribeAudio } from '../../src/lib/asr';
import { getEpisode, putEpisode, updateEpisode } from '../../src/lib/db';
import { llmReady } from '../../src/lib/llm';
import type { OffscreenRequest } from '../../src/lib/messages';
import { punctuateItems } from '../../src/lib/punctuate';
import { translateWithGoogle, translateWithLlm } from '../../src/lib/translate';
import type { EpisodeRecord } from '../../src/lib/types';
import { EPISODE_KEY } from '../../src/lib/types';

const controllers = new Map<string, AbortController>();
const running = new Set<string>();
const punctuateControllers = new Map<string, AbortController>();
const punctuateRuns = new Set<string>();
/** Bumped whenever a translation starts; a punctuation pass from an older epoch must not write. */
const translationEpoch = new Map<string, number>();
const epochOf = (videoId: string) => translationEpoch.get(videoId) ?? 0;

function send(msg: unknown) {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* background is restarting; the next event will wake it */
  }
}

function normalize(items: (string | null)[], n: number): (string | null)[] {
  const out = items.slice(0, n);
  while (out.length < n) out.push(null);
  return out;
}

async function runTranslate(msg: Extract<OffscreenRequest, { type: 'OFFSCREEN_TRANSLATE' }>): Promise<void> {
  const { videoId } = msg;
  if (running.has(videoId)) return;
  // A fresh translation replaces every item, so a punctuation pass on the old items must stop.
  punctuateControllers.get(videoId)?.abort();
  translationEpoch.set(videoId, epochOf(videoId) + 1);
  running.add(videoId);
  const controller = new AbortController();
  controllers.set(videoId, controller);
  const key = EPISODE_KEY(videoId);
  try {
    const ep = await getEpisode(key);
    if (!ep?.segments.length) throw new Error('找不到这个视频的字幕');
    if (msg.engine === 'llm' && !llmReady(msg.llm)) throw new Error('模型服务没有配置好');
    const engine = msg.engine;
    const model = engine === 'llm' ? msg.llm.model : 'google';
    let saveChain: Promise<unknown> = Promise.resolve();
    const persist = (items: (string | null)[]) => {
      const aligned = normalize(items, ep.segments.length);
      const done = aligned.filter((x) => x != null && x !== '').length;
      saveChain = saveChain.then(() =>
        updateEpisode(key, (cur) => ({
          ...cur,
          translation: { lang: 'zh-CN', engine, model, items: aligned, status: 'partial', updatedAt: Date.now() },
          updatedAt: Date.now(),
        })),
      );
      send({ type: 'TR_PROGRESS', videoId, items: aligned, done, total: ep.segments.length });
    };
    const result =
      engine === 'llm'
        ? await translateWithLlm(ep.segments, ep.translation?.items ?? [], {
            title: msg.title,
            show: msg.show,
            cfg: msg.llm,
            signal: controller.signal,
            onProgress: persist,
          })
        : await translateWithGoogle(ep.segments, ep.translation?.items ?? [], {
            title: msg.title,
            show: msg.show,
            signal: controller.signal,
            onProgress: persist,
          });
    await saveChain;
    const aligned = normalize(result.items, ep.segments.length);
    const complete = ep.segments.every((s, i) => s.text.trim() === '' || aligned[i] != null);
    await updateEpisode(key, (cur) => ({
      ...cur,
      translation: { lang: 'zh-CN', engine, model, items: aligned, status: complete ? 'done' : 'partial', updatedAt: Date.now() },
      updatedAt: Date.now(),
    }));
    send({ type: 'TR_DONE', videoId, translated: result.translated, total: ep.segments.length });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') send({ type: 'TR_CANCELLED', videoId });
    else send({ type: 'TR_ERROR', videoId, message: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(videoId);
    running.delete(videoId);
  }
}

async function runPunctuate(msg: Extract<OffscreenRequest, { type: 'OFFSCREEN_PUNCTUATE' }>): Promise<void> {
  const { videoId } = msg;
  if (punctuateRuns.has(videoId)) return;
  if (running.has(videoId)) {
    send({ type: 'PU_CANCELLED', videoId });
    return;
  }
  punctuateRuns.add(videoId);
  const epoch = epochOf(videoId);
  const controller = new AbortController();
  punctuateControllers.set(videoId, controller);
  const key = EPISODE_KEY(videoId);
  try {
    const ep = await getEpisode(key);
    if (!ep?.translation) {
      send({ type: 'PU_DONE', videoId, changed: 0, total: 0 });
      return;
    }
    let saveChain: Promise<unknown> = Promise.resolve();
    const persist = (items: (string | null)[]) => {
      saveChain = saveChain.then(() =>
        updateEpisode(key, (cur) => {
          if (!cur.translation || epochOf(videoId) !== epoch) return cur;
          return { ...cur, translation: { ...cur.translation, items }, updatedAt: Date.now() };
        }),
      );
    };
    const result = await punctuateItems(ep.segments, ep.translation.items, {
      cfg: msg.llm,
      signal: controller.signal,
      onProgress: (items, done, total) => {
        persist(items);
        send({ type: 'PU_PROGRESS', videoId, done, total });
      },
    });
    await saveChain;
    await updateEpisode(key, (cur) => {
      if (!cur.translation || epochOf(videoId) !== epoch) return cur;
      return {
        ...cur,
        translation: { ...cur.translation, items: result.items, punctuatedAt: Date.now() },
        updatedAt: Date.now(),
      };
    });
    send({ type: 'PU_DONE', videoId, changed: result.changed, total: result.items.length });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') send({ type: 'PU_CANCELLED', videoId });
    else send({ type: 'PU_ERROR', videoId, message: e instanceof Error ? e.message : String(e) });
  } finally {
    punctuateControllers.delete(videoId);
    punctuateRuns.delete(videoId);
  }
}

async function runAsr(msg: Extract<OffscreenRequest, { type: 'OFFSCREEN_ASR' }>): Promise<void> {
  const { videoId } = msg;
  if (running.has(videoId)) return;
  running.add(videoId);
  const controller = new AbortController();
  controllers.set(videoId, controller);
  const key = EPISODE_KEY(videoId);
  try {
    const old = await getEpisode(key);
    const result = await transcribeAudio(msg.audioUrl, {
      provider: msg.provider,
      apiKey: msg.apiKey,
      model: msg.model,
      language: msg.language,
      signal: controller.signal,
      onProgress: (stage, percent, message) => send({ type: 'ASR_PROGRESS', videoId, stage, percent, message }),
    });
    const lastEnd = result.segments[result.segments.length - 1]?.end ?? 0;
    const rec: EpisodeRecord = {
      key,
      videoId,
      title: msg.meta.title || old?.title || '',
      channel: msg.meta.channel || old?.channel || '',
      duration: Math.max(msg.meta.duration || 0, lastEnd + 1),
      language: result.language,
      source: 'cloud',
      segments: result.segments,
      translation: null,
      asrModel: result.model,
      createdAt: old?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await putEpisode(rec);
    send({ type: 'ASR_DONE', videoId, language: result.language, model: result.model, segments: result.segments });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') send({ type: 'ASR_ERROR', videoId, message: '已取消' });
    else send({ type: 'ASR_ERROR', videoId, message: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(videoId);
    running.delete(videoId);
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, _sendResponse) => {
  if (!msg?.type) return false;
  if (msg.type === 'OFFSCREEN_TRANSLATE') {
    void runTranslate(msg);
    return false;
  }
  if (msg.type === 'OFFSCREEN_ASR') {
    void runAsr(msg);
    return false;
  }
  if (msg.type === 'OFFSCREEN_PUNCTUATE') {
    void runPunctuate(msg);
    return false;
  }
  if (msg.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.videoId)?.abort();
    punctuateControllers.get(msg.videoId)?.abort();
    return false;
  }
  return false;
});

send({ type: 'OFFSCREEN_READY' });
console.log('[subcast] offscreen ready');
