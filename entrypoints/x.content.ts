/** X (Twitter) video posts. The player streams through MSE, so the page's own <video> source is a
 *  blob URL and videos have no caption track; this script reports the post's title/author, seeks the
 *  page player, and passes along an MP4 URL from the page metadata when one is present. Otherwise
 *  the background resolves the MP4 from X's public syndication API. */
import { serveEpisodePage } from '../src/lib/episode-page';
import type { VideoMeta } from '../src/lib/types';
import { xStatusIdFromUrl } from '../src/lib/x';

function metaContent(name: string): string {
  const el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`);
  return (el?.getAttribute('content') ?? '').trim();
}

function focalArticle(id: string): HTMLElement | null {
  const articles = Array.from(document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  return articles.find((a) => a.querySelector(`a[href*="/status/${id}"]`)) ?? articles[0] ?? null;
}

/** The focal post's video, not a video inside a quoted post. */
function focalVideo(id: string): HTMLVideoElement | null {
  const article = focalArticle(id);
  if (!article) return null;
  const video = article.querySelector('video');
  if (video && video.closest('article[data-testid="tweet"]') !== article) return null;
  return video;
}

function postText(article: HTMLElement | null): string {
  const text = (article?.querySelector('[data-testid="tweetText"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 200);
  return document.title.replace(/\s*\/\s*X.*$/i, '').trim() || 'X 视频';
}

function postAuthor(article: HTMLElement | null): string {
  const name = (article?.querySelector('[data-testid="User-Name"] span')?.textContent ?? '').trim();
  return name || metaContent('og:title');
}

/** og:video is the progressive MP4 X publishes for embedded players; HLS playlists are useless
 *  here because the offscreen document decodes a single downloaded file. When the player poster
 *  carries a media id, only URLs for that media are accepted so a stale meta tag from an earlier
 *  post (X navigates client-side) cannot send the wrong video to the recognizer. */
function pageMp4(video: HTMLVideoElement | null): string | undefined {
  const mediaId = video?.poster.match(/\/(?:amplify|ext_tw)_video_thumb\/(\d+)\//)?.[1] ?? '';
  const sources = Array.from(video?.querySelectorAll<HTMLSourceElement>('source') ?? []).map(
    (s) => s.src || s.getAttribute('src'),
  );
  const candidates = [
    video?.currentSrc,
    video?.src,
    video?.getAttribute('src'),
    ...sources,
    metaContent('og:video:secure_url'),
    metaContent('og:video'),
    metaContent('twitter:player:stream'),
  ].filter((u): u is string => Boolean(u));
  return candidates.find(
    (u) => /^https:\/\/video\.twimg\.com\/.+\.mp4(?:$|\?)/.test(u) && (!mediaId || u.includes(`/${mediaId}/`)),
  );
}

function meta(videoId: string): VideoMeta {
  const id = videoId.replace(/^x:/, '');
  const article = focalArticle(id);
  const video = focalVideo(id);
  return {
    videoId,
    title: postText(article),
    channel: postAuthor(article),
    duration: Number.isFinite(video?.duration) ? Math.round(video!.duration) : 0,
    url: location.href,
    tracks: [],
    audio: [],
    audioUrl: pageMp4(video),
    site: 'x',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main() {
    let currentId: string | null = null;
    serveEpisodePage({
      videoIdFromUrl: (url) => {
        const id = xStatusIdFromUrl(url);
        currentId = id ? `x:${id}` : null;
        return currentId;
      },
      resolveMeta: async (videoId) => meta(videoId),
      player: () => {
        const id = currentId?.replace(/^x:/, '');
        return id ? focalVideo(id) : null;
      },
    });
  },
});
