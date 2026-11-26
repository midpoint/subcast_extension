/** X (Twitter) video posts. The page plays video through a blob/MSE player and exposes no caption
 *  track, so the background resolves the post's progressive MP4 from X's public syndication API —
 *  the same JSON used to render embedded tweets — and the offscreen document downloads that file
 *  for cloud ASR. HLS-only posts cannot be decoded in the browser and are reported as unavailable. */
import type { PodcastEpisode, VideoMeta } from './types';

const X_HOSTS = /(^|\.)(x|twitter)\.com$/;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: PodcastEpisode }>();

/** Status ids appear as `/user/status/<id>`, `/i/status/<id>` (short links) and with a trailing
 *  `/video/1` or `/photo/1` when a media tab is open. */
export function xStatusIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!X_HOSTS.test(u.hostname)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    const i = segs.findIndex((s) => s === 'status' || s === 'statuses');
    if (i < 0) return null;
    const id = segs[i + 1];
    return id && /^\d{5,25}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The `token` the syndication endpoint expects: the post id scaled into base36, with dots and
 *  leading zeros stripped. Same computation the web client uses for embedded tweets. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

interface Variant {
  content_type?: string;
  type?: string;
  src?: string;
  bitrate?: number;
}

interface TweetResult {
  text?: string;
  user?: { name?: string; screen_name?: string };
  video?: { durationMs?: number; variants?: Variant[] };
}

/** Progressive MP4 only: an HLS playlist would need segment-wise download and decode. */
export function pickXMp4(result: TweetResult): string | null {
  const variants = result.video?.variants ?? [];
  const mp4 = variants.filter((v) => /^video\/mp4/.test(v.content_type ?? v.type ?? '') && v.src);
  mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return mp4[0]?.src ?? null;
}

function tweetTitle(data: TweetResult): string {
  const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200) || 'X 视频';
}

function tweetChannel(data: TweetResult): string {
  const name = (data.user?.name ?? '').trim();
  const handle = (data.user?.screen_name ?? '').trim();
  if (name && handle) return `${name} (@${handle})`;
  return name || (handle ? `@${handle}` : '');
}

export async function fetchXPost(id: string): Promise<PodcastEpisode | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`X 媒体信息请求失败（HTTP ${res.status}）`);
  const data = (await res.json()) as TweetResult;
  const audioUrl = pickXMp4(data);
  if (!audioUrl) return null;
  const episode: PodcastEpisode = {
    title: tweetTitle(data),
    channel: tweetChannel(data),
    duration: data.video?.durationMs ? Math.round(data.video.durationMs / 1000) : 0,
    audioUrl,
  };
  cache.set(id, { at: Date.now(), value: episode });
  return episode;
}

export async function resolveXEpisode(
  meta: VideoMeta,
): Promise<{ episode: PodcastEpisode; sharedKeys: string[] } | null> {
  const id = xStatusIdFromUrl(meta.url) ?? meta.videoId.match(/^x:(\d+)$/)?.[1];
  if (!id) return null;
  const episode = await fetchXPost(id);
  if (!episode) return null;
  return { episode: { ...episode, duration: episode.duration || meta.duration }, sharedKeys: [] };
}
