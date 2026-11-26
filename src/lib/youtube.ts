/** YouTube subtitles without the viewer's cookies: the watch page's player response first, then
 *  InnerTube's mobile clients (the same route the desktop app uses). Runs in the background, which
 *  has host permissions, so CORS on youtube.com is not a problem. */
import { parseYoutube } from './captions';
import type { AudioFormat, CaptionTrack, Segment, VideoMeta } from './types';

interface InnerTubeClient {
  name: string;
  version: string;
  sdk?: number;
}

const CLIENTS: InnerTubeClient[] = [
  { name: 'ANDROID', version: '20.10.38', sdk: 34 },
  { name: 'IOS', version: '20.10.3' },
  { name: 'ANDROID_VR', version: '1.60.19', sdk: 32 },
  { name: 'WEB', version: '2.20241101.01.00' },
];

const baseLang = (lang: string) => (lang.split(/[-_]/)[0] ?? lang).toLowerCase();

function textOf(node: unknown): string {
  const n = node as { simpleText?: string; runs?: { text?: string }[] } | undefined;
  return n?.simpleText ?? (n?.runs ?? []).map((r) => r.text ?? '').join('') ?? '';
}

function captionTracks(player: any): CaptionTrack[] {
  const list = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];
  return list
    .map((t: any): CaptionTrack | null => {
      const url: string | undefined = t?.baseUrl;
      if (!url) return null;
      // Token-gated tracks need the web player's proof; skip them.
      if (url.includes('exp=xpe')) return null;
      return {
        baseUrl: url,
        language: t.languageCode ?? 'und',
        auto: t.kind === 'asr',
        name: textOf(t.name) || t.languageCode || '字幕',
        vssId: t.vssId,
      };
    })
    .filter((t: CaptionTrack | null): t is CaptionTrack => t != null);
}

function audioFormats(player: any): AudioFormat[] {
  const list = player?.streamingData?.adaptiveFormats;
  if (!Array.isArray(list)) return [];
  return list
    .filter((f: any) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f.url === 'string')
    .map((f: any) => ({
      url: f.url,
      mimeType: f.mimeType,
      bitrate: f.bitrate,
      itag: f.itag,
      contentLength: Number(f.contentLength) || undefined,
      audioQuality: f.audioQuality,
    }))
    .sort((a: AudioFormat, b: AudioFormat) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
}

/** Language of an audio track, from its id (`en.4`, `zh-CN.2`). */
function audioTrackLang(track: any): string | undefined {
  const id: string | undefined =
    typeof track?.audioTrackId === 'string' ? track.audioTrackId : typeof track?.id === 'string' ? track.id : undefined;
  if (!id) return undefined;
  const lang = baseLang(id.split('.')[0] ?? id);
  return /^[a-z]{2,3}$/.test(lang) ? lang : undefined;
}

/** Display names are localized, so "original" is only a fallback. The default audio track is the
 *  language the viewer actually hears — for a dubbed video that may be a dub, not the original. */
function originalLanguage(player: any): string | undefined {
  const named = new Set<string>();
  const all = new Set<string>();
  let defaultLang: string | undefined;
  for (const key of ['formats', 'adaptiveFormats']) {
    const arr = player?.streamingData?.[key];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      const track = f?.audioTrack;
      const lang = audioTrackLang(track);
      if (!lang) continue;
      all.add(lang);
      const name: string = typeof track?.displayName === 'string' ? track.displayName.toLowerCase() : '';
      if (/original|原始|原聲|原声/.test(name)) named.add(lang);
      if (track?.audioIsDefault === true) defaultLang ??= lang;
    }
  }
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const list = renderer?.audioTracks;
  if (Array.isArray(list) && list.length) {
    for (const t of list) {
      const lang = audioTrackLang(t);
      if (lang) all.add(lang);
    }
    const idx = Number(renderer?.defaultAudioTrackIndex);
    const pick = Number.isInteger(idx) && idx >= 0 && idx < list.length ? list[idx] : list.find((t: any) => t?.hasDefaultAudioTrack === true);
    const lang = audioTrackLang(pick);
    if (lang) return lang;
  }
  if (defaultLang) return defaultLang;
  if (named.size === 1) return [...named][0];
  // One audio language and several auto-caption languages (dubbing without a default flag).
  return all.size === 1 ? [...all][0] : undefined;
}

/** Normalize a `playerResponse` (watch page or InnerTube) into what the extension uses. */
export function metaFromPlayerResponse(player: any, videoId: string, url: string, origin: 'page' | 'innertube' = 'page'): VideoMeta | null {
  const d = player?.videoDetails;
  if (!d || (d.videoId && d.videoId !== videoId)) return null;
  return {
    videoId,
    title: d.title ?? '',
    channel: d.author ?? '',
    duration: Number(d.lengthSeconds) || 0,
    url,
    tracks: captionTracks(player),
    audio: audioFormats(player),
    originalLanguage: originalLanguage(player),
    channelId: typeof d.channelId === 'string' ? d.channelId : undefined,
    capturedAt: Date.now(),
    origin,
  };
}

export async function fetchInnerTubeMeta(videoId: string, url = `https://www.youtube.com/watch?v=${videoId}`): Promise<VideoMeta | null> {
  let lastError: unknown = null;
  for (const c of CLIENTS) {
    const client: Record<string, unknown> = { clientName: c.name, clientVersion: c.version, hl: 'en' };
    if (c.sdk) client.androidSdkVersion = c.sdk;
    const body = {
      context: { client },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        lastError = new Error(`YouTube ${res.status}`);
        continue;
      }
      const player = (await res.json()) as any;
      const meta = metaFromPlayerResponse(player, videoId, url, 'innertube');
      if (meta && (meta.tracks.length || meta.audio.length || meta.title)) return meta;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) console.warn('[subcast] InnerTube failed', lastError);
  return null;
}

/** Fetch one caption track as json3 (falling back to the track's own XML) and parse it. */
export async function fetchTrackSegments(track: CaptionTrack): Promise<Segment[]> {
  const base = track.baseUrl.replace(/&fmt=[^&]*/g, '');
  for (const url of [`${base}&fmt=json3`, base]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const body = await res.text();
      const segments = parseYoutube(body);
      if (segments.length) return segments;
    } catch {
      /* try the next format */
    }
  }
  return [];
}
