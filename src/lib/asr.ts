/** Cloud ASR fallback, best-effort. Runs in the offscreen document: YouTube audio is fetched there,
 *  decoded to 16 kHz mono with Web Audio, cut into ~8-minute WAV chunks (under the 25 MB API limit)
 *  and transcribed with the user's own Groq / OpenAI key. No local programs, no yt-dlp. */
import { clean, resegment, splitTimed } from './captions';
import type { AudioFormat, Segment } from './types';

export type AsrProvider = 'groq' | 'openai';

export interface AsrOptions {
  provider: AsrProvider;
  apiKey: string;
  model: string;
  /** BCP-47 code, or "auto" to let the service detect it. */
  language: string;
  signal?: AbortSignal;
  onProgress?: (stage: 'download' | 'decode' | 'upload' | 'segment', percent: number, message: string) => void;
}

export interface AsrResult {
  segments: Segment[];
  language: string;
  model: string;
}

const SAMPLE_RATE = 16_000;
const CHUNK_SECS = 480;
const ENDPOINTS: Record<AsrProvider, string> = {
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions',
};

export function bestAudio(audio: AudioFormat[]): AudioFormat | null {
  if (!audio.length) return null;
  // AAC in MP4 decodes reliably with Web Audio; Opus/WebM is the second choice.
  const rank = (f: AudioFormat) => (/mp4|m4a|aac/i.test(f.mimeType) ? 0 : /webm|opus/i.test(f.mimeType) ? 1 : 2);
  return [...audio].sort((a, b) => rank(a) - rank(b) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('识别已取消', 'AbortError');
}

async function fetchAudio(url: string, signal: AbortSignal | undefined, onProgress: AsrOptions['onProgress']): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`无法下载视频音频（HTTP ${res.status}）。该视频可能受限制。`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    if (total) onProgress?.('download', Math.min(99, (got / total) * 100), `下载音频 ${Math.round(got / 1048576)} / ${Math.round(total / 1048576)} MB`);
  }
  onProgress?.('download', 100, '音频下载完成');
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out.buffer;
}

/** 16-bit PCM WAV, the format every Whisper endpoint accepts. */
export function wavBlob(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const dataBytes = samples.length * 2;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  write(36, 'data');
  v.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('识别已取消', 'AbortError'));
    }, { once: true });
  });

async function postChunk(blob: Blob, opts: AsrOptions, chunkSecs: number): Promise<{ segments: Segment[]; language: string }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(opts.signal);
    const form = new FormData();
    form.append('file', blob, 'audio.wav');
    form.append('model', opts.model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (opts.language && opts.language !== 'auto') form.append('language', opts.language);
    try {
      const res = await fetch(ENDPOINTS[opts.provider], {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: opts.signal ?? AbortSignal.timeout(300_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const msg = `识别服务返回 ${res.status}${body ? `：${body.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`;
        if (res.status === 401 || res.status === 403) throw new Error(`${msg}（请检查 Key）`);
        lastError = new Error(msg);
        if (res.status === 429 || res.status >= 500) {
          await sleep(1500 * (attempt + 1), opts.signal);
          continue;
        }
        throw lastError;
      }
      const data = (await res.json()) as { segments?: { start: number; end: number; text: string }[]; text?: string; language?: string };
      const language = normalizeLanguage(data.language);
      let segments = (data.segments ?? [])
        .map((s) => ({ start: Number(s.start), end: Number(s.end), text: (s.text ?? '').trim() }))
        .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
      if (!segments.length && data.text?.trim()) segments = splitTimed(data.text.trim(), 0, chunkSecs);
      return { segments, language };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < 2) await sleep(1200 * (attempt + 1), opts.signal);
    }
  }
  throw lastError ?? new Error('识别服务没有返回内容');
}

const LANG_NAMES: Record<string, string> = {
  english: 'en', chinese: 'zh', mandarin: 'zh', japanese: 'ja', korean: 'ko', spanish: 'es', french: 'fr',
  german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru', hindi: 'hi', arabic: 'ar', dutch: 'nl',
  turkish: 'tr', polish: 'pl', ukrainian: 'uk', vietnamese: 'vi', thai: 'th', indonesian: 'id',
};

export function normalizeLanguage(raw: string | undefined): string {
  if (!raw) return 'en';
  const low = raw.toLowerCase();
  return LANG_NAMES[low] ?? (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(raw) ? raw : 'en');
}

/** Download → decode → chunk → transcribe. Throws a clear message when the audio cannot be decoded. */
export async function transcribeAudio(url: string, opts: AsrOptions): Promise<AsrResult> {
  if (!opts.apiKey.trim()) throw new Error('没有填写云端识别服务的 Key（设置 › 云端识别）');
  opts.onProgress?.('download', 0, '开始下载音频');
  const buffer = await fetchAudio(url, opts.signal, opts.onProgress);
  checkAbort(opts.signal);
  opts.onProgress?.('decode', 0, '解码音频');
  let audio: AudioBuffer;
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    audio = await ctx.decodeAudioData(buffer.slice(0));
  } catch {
    await ctx.close().catch(() => {});
    throw new Error('这段音频的编码浏览器无法解码，无法云端识别。可以换一个视频试试。');
  }
  const samples = audio.getChannelData(0);
  const seconds = audio.duration;
  const total = Math.max(1, Math.ceil(seconds / CHUNK_SECS));
  const segments: Segment[] = [];
  let language = opts.language !== 'auto' ? opts.language : 'en';
  try {
    for (let i = 0; i < total; i++) {
      checkAbort(opts.signal);
      const start = i * CHUNK_SECS;
      const end = Math.min(seconds, start + CHUNK_SECS);
      const offset = Math.floor(start * SAMPLE_RATE);
      const len = Math.floor((end - start) * SAMPLE_RATE);
      const piece = samples.subarray(offset, offset + len);
      opts.onProgress?.('upload', (i / total) * 100, `识别第 ${i + 1} / ${total} 段`);
      const got = await postChunk(wavBlob(piece), opts, end - start);
      if (i === 0 && opts.language === 'auto') language = got.language;
      for (const s of got.segments) segments.push({ start: s.start + start, end: s.end + start, text: s.text });
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  opts.onProgress?.('segment', 100, '整理字幕');
  const cleaned = resegment(clean(segments));
  if (!cleaned.length) throw new Error('识别服务没有返回任何字幕');
  return { segments: cleaned, language, model: opts.model };
}
