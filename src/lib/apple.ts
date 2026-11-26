/** Apple Podcasts episode pages. The page is a SPA with no audio URL in its HTML, but every episode is
 *  also in the show's public iTunes catalogue, which lists the full episode audio. The lookup returns
 *  the most recent 200 episodes; older ones cannot be resolved this way (the panel says so). */
import type { PodcastEpisode } from './types';

export interface AppleUrlInfo {
  showId: string;
  episodeId: string | null;
  /** Storefront from the path (`/cn/…`); the lookup needs it for region-specific shows. */
  country: string;
}

export function appleUrlInfo(url: string): AppleUrlInfo | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)podcasts\.apple\.com$/.test(u.hostname)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    // /cn/podcast/<slug>/id1482731836  (+ ?i=<episodeId> for one episode)
    const podcastIndex = segs.findIndex((s) => s.toLowerCase() === 'podcast');
    const idIndex = segs.findIndex((s) => /^id\d+$/.test(s));
    if (podcastIndex < 0 || idIndex <= podcastIndex) return null;
    const episodeId = u.searchParams.get('i')?.match(/^\d+$/)?.[0] ?? null;
    const country = segs[0] && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segs[0]) ? segs[0].toLowerCase() : 'us';
    return { showId: segs[idIndex].slice(2), episodeId, country };
  } catch {
    return null;
  }
}

export function appleEpisodeIdFromUrl(url: string): string | null {
  return appleUrlInfo(url)?.episodeId ?? null;
}

/** Picks one episode out of a lookup response. Split out so the selection is unit-tested. */
export function pickAppleEpisode(results: unknown, episodeId: string): PodcastEpisode | null {
  if (!Array.isArray(results)) return null;
  const row = results.find(
    (r: any) => r?.wrapperType === 'podcastEpisode' && String(r?.trackId ?? '') === episodeId,
  );
  if (!row) return null;
  const audioUrl = typeof row.episodeUrl === 'string' && /^https?:\/\//.test(row.episodeUrl) ? row.episodeUrl : undefined;
  return {
    title: typeof row.trackName === 'string' ? row.trackName : '',
    channel: typeof row.collectionName === 'string' ? row.collectionName : '',
    duration: Number.isFinite(row.trackTimeMillis) ? Math.round(Number(row.trackTimeMillis) / 1000) : 0,
    audioUrl,
    guid: typeof row.episodeGuid === 'string' && row.episodeGuid ? row.episodeGuid : undefined,
  };
}

/** One lookup per show is enough for every episode of it the user opens in a session. */
const cache = new Map<string, { at: number; results: unknown }>();
const CACHE_MS = 10 * 60_000;
const CACHE_SHOWS = 4;

export async function fetchAppleEpisode(showId: string, episodeId: string, country = 'us'): Promise<PodcastEpisode | null> {
  const cacheKey = `${country}:${showId}`;
  const hit = cache.get(cacheKey);
  let results: unknown;
  if (hit && Date.now() - hit.at < CACHE_MS) {
    results = hit.results;
  } else {
    const qs = new URLSearchParams({ id: showId, entity: 'podcastEpisode', limit: '200', country });
    const res = await fetch(`https://itunes.apple.com/lookup?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: unknown };
    results = body?.results;
    if (!Array.isArray(results)) return null;
    cache.set(cacheKey, { at: Date.now(), results });
    while (cache.size > CACHE_SHOWS) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }
  return pickAppleEpisode(results, episodeId);
}
