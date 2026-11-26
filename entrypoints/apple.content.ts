/** Apple Podcasts episode pages. The page is a SPA shell and its player may use a blob URL, so this
 *  script only reports title/show from the DOM; the background resolves the public audio file and
 *  duration from the show's iTunes catalogue. */
import { appleUrlInfo } from '../src/lib/apple';
import { serveEpisodePage } from '../src/lib/episode-page';
import type { VideoMeta } from '../src/lib/types';

function pageAudio(): HTMLAudioElement | null {
  const list = Array.from(document.querySelectorAll('audio'));
  return list.find((a) => a.src || a.currentSrc) ?? list[0] ?? null;
}

function episodeTitle(): string {
  const h1 = Array.from(document.querySelectorAll('h1'))
    .map((el) => (el.textContent ?? '').trim())
    .find((t) => t && !/受限制内容|restricted/i.test(t));
  if (h1) return h1;
  return document.title
    .replace(/\s*[-–—|｜]\s*(Apple Podcasts|Apple 播客|Podcasts).*$/i, '')
    .trim();
}

function showName(): string {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/podcast/"]'));
  const show = links.find((a) => /\/id\d+\/?$/.test(a.pathname) && !a.href.includes('?i='));
  return (show?.textContent ?? '').trim();
}

function meta(videoId: string): VideoMeta {
  const audio = pageAudio();
  const src = audio?.src || audio?.currentSrc || '';
  return {
    videoId,
    title: episodeTitle(),
    channel: showName(),
    duration: Number.isFinite(audio?.duration) ? audio!.duration : 0,
    url: location.href,
    tracks: [],
    audio: [],
    audioUrl: /^https?:\/\//.test(src) ? src : undefined,
    site: 'apple',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

export default defineContentScript({
  matches: ['https://podcasts.apple.com/*'],
  runAt: 'document_idle',
  main() {
    serveEpisodePage({
      videoIdFromUrl: (url) => {
        const id = appleUrlInfo(url)?.episodeId;
        return id ? `pod:ap:${id}` : null;
      },
      resolveMeta: async (videoId) => meta(videoId),
      player: pageAudio,
    });
  },
});
