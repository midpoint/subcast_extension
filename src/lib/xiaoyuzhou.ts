/** Xiaoyuzhou (小宇宙) episode pages. The server-rendered `__NEXT_DATA__` carries the episode id,
 *  title, duration, show name and the audio file the web player streams, so no private API is needed.
 *  The episode key matches the desktop app (`qm:<eid>`), which also lets the shared library hit. */
import type { VideoMeta } from './types';

export interface XmEpisode {
  eid: string;
  title: string;
  show: string;
  duration: number;
  audioUrl?: string;
  paid: boolean;
}

export function episodeIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)xiaoyuzhoufm\.com$/.test(u.hostname)) return null;
    return u.pathname.match(/^\/episode\/([0-9a-f]{24})(?:\/|$)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function nextDataFromHtml(html: string): any | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function episodeFromNextData(data: any): XmEpisode | null {
  const e = data?.props?.pageProps?.episode;
  if (!e || typeof e.eid !== 'string') return null;
  const mode = e?.media?.source?.mode;
  const paid = e?.isPrivateMedia === true || (e?.payType != null && e.payType !== 'FREE') || mode === 'PRIVATE';
  const raw = e?.media?.source?.url ?? e?.enclosure?.url;
  const audioUrl = !paid && typeof raw === 'string' && /^https?:\/\//.test(raw) ? raw : undefined;
  return {
    eid: e.eid,
    title: typeof e.title === 'string' ? e.title : '',
    show: typeof e.podcast?.title === 'string' ? e.podcast.title : '',
    duration: Number(e.duration) || 0,
    audioUrl,
    paid,
  };
}

export function episodeMetaFromNextData(data: any, url: string): VideoMeta | null {
  const ep = episodeFromNextData(data);
  if (!ep) return null;
  return {
    videoId: `qm:${ep.eid}`,
    title: ep.title,
    channel: ep.show,
    duration: ep.duration,
    url,
    tracks: [],
    audio: [],
    audioUrl: ep.audioUrl,
    site: 'xiaoyuzhou',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

/** Parse a full episode page (initial load, or a same-origin re-fetch after in-page navigation). */
export function episodeMetaFromHtml(html: string, url: string): VideoMeta | null {
  return episodeMetaFromNextData(nextDataFromHtml(html), url);
}
