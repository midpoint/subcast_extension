/** Ximalaya (喜马拉雅) sound pages. The playback API needs a logged-in account, but every public
 *  album also has a free RSS feed at `/album/<albumId>.xml`; the episode's enclosure is the same
 *  audio file the web player streams. The page only links to its album, so the album id comes from
 *  the page DOM and the feed is read here in the background. */
import { parseDuration, rssItems, tagAttr, tagText } from './rss';
import type { PodcastEpisode } from './types';

export function ximalayaSoundIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)ximalaya\.com$/.test(u.hostname)) return null;
    return u.pathname.match(/^\/sound\/(\d+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseXimalayaRss(xml: string, soundId: string): PodcastEpisode | null {
  const items = rssItems(xml);
  const wanted = new RegExp(`/sound/${soundId}(?:[/?#]|$)`);
  const item =
    items.find((i) => wanted.test(tagText(i, 'link'))) ??
    items.find((i) => tagAttr(i, 'enclosure', 'url').includes(`track_id=${soundId}`));
  if (!item) return null;
  const audioUrl = tagAttr(item, 'enclosure', 'url');
  if (!/^https?:\/\//.test(audioUrl)) return null;
  const channel = xml.match(/<channel\b[^>]*>([\s\S]*?)(?:<item\b|<\/channel>)/i)?.[1] ?? '';
  return {
    title: tagText(item, 'title'),
    channel: tagText(channel, 'title'),
    duration: parseDuration(tagText(item, 'itunes:duration')),
    audioUrl,
    guid: tagText(item, 'guid') || undefined,
  };
}

/** Album feeds are ~1 MB; keep a couple around so paging through a show does not re-download one. */
const cache = new Map<string, { at: number; xml: string }>();
const CACHE_MS = 10 * 60_000;
const CACHE_ALBUMS = 3;

export async function fetchXimalayaEpisode(albumId: string, soundId: string): Promise<PodcastEpisode | null> {
  if (!/^\d+$/.test(albumId) || !/^\d+$/.test(soundId)) return null;
  const hit = cache.get(albumId);
  let xml: string;
  if (hit && Date.now() - hit.at < CACHE_MS) {
    xml = hit.xml;
  } else {
    const res = await fetch(`https://www.ximalaya.com/album/${albumId}.xml`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    xml = await res.text();
    cache.set(albumId, { at: Date.now(), xml });
    while (cache.size > CACHE_ALBUMS) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }
  return parseXimalayaRss(xml, soundId);
}
