/** Ximalaya (喜马拉雅) sound pages. The page knows its album and title but no public audio URL; the
 *  background reads the album's RSS feed. The player is click-to-play, so seeking only works after
 *  the page has created its <audio> element. */
import { serveEpisodePage } from '../src/lib/episode-page';
import type { VideoMeta } from '../src/lib/types';
import { ximalayaSoundIdFromUrl } from '../src/lib/ximalaya';

interface AlbumLink {
  id: string;
  name: string;
}

/** The first `/album/` link is the show's own; recommendation lists follow it. Prefer the link whose
 *  text also appears in the page title, so a reordered page still picks the right album. */
function albumLink(): AlbumLink | null {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/album/"]'));
  const parsed = links
    .map((a) => ({ id: a.href.match(/\/album\/(\d+)/)?.[1] ?? '', name: (a.textContent ?? '').trim() }))
    .filter((x) => x.id);
  return parsed.find((x) => x.name && document.title.includes(x.name)) ?? parsed[0] ?? null;
}

function episodeTitle(): string {
  const h1 = Array.from(document.querySelectorAll('h1'))
    .map((el) => (el.textContent ?? '').trim())
    .find(Boolean);
  if (h1) return h1;
  return document.title.split('_')[0]?.trim() ?? '';
}

function pageAudio(): HTMLAudioElement | null {
  const list = Array.from(document.querySelectorAll('audio'));
  return list.find((a) => a.src || a.currentSrc) ?? list[0] ?? null;
}

/** The page is a client-rendered SPA; the album link appears a moment after the document is idle. */
async function waitForAlbum(timeoutMs = 8_000): Promise<AlbumLink | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = albumLink();
    if (found || Date.now() >= until) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function meta(videoId: string, album: AlbumLink | null): VideoMeta {
  const audio = pageAudio();
  return {
    videoId,
    title: episodeTitle(),
    channel: album?.name ?? '',
    duration: Number.isFinite(audio?.duration) ? audio!.duration : 0,
    url: location.href,
    tracks: [],
    audio: [],
    albumId: album?.id,
    site: 'ximalaya',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

export default defineContentScript({
  matches: ['https://www.ximalaya.com/*'],
  runAt: 'document_idle',
  main() {
    serveEpisodePage({
      videoIdFromUrl: (url) => {
        const id = ximalayaSoundIdFromUrl(url);
        return id ? `pod:xm:${id}` : null;
      },
      resolveMeta: async (videoId) => meta(videoId, await waitForAlbum()),
      audio: pageAudio,
    });
  },
});
