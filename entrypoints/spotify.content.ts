/** Spotify episode pages. Audio is DRM-protected, so the panel explains why subtitles are not
 *  possible instead of offering cloud ASR. The page is still a podcast episode, so report its
 *  title/show for the panel header. */
import { serveEpisodePage } from '../src/lib/episode-page';
import { pickSpotifyEpisode, spotifyEpisodeIdFromUrl } from '../src/lib/spotify';
import type { VideoMeta } from '../src/lib/types';

function metaContent(name: string): string {
  const el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`);
  return (el?.getAttribute('content') ?? '').trim();
}

function jsonld(): unknown[] {
  const out: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      out.push(JSON.parse(script.textContent ?? ''));
    } catch {
      /* not JSON; ignore */
    }
  }
  return out;
}

function meta(videoId: string): VideoMeta {
  const parsed = pickSpotifyEpisode(jsonld());
  const h1 = Array.from(document.querySelectorAll('h1'))
    .map((el) => (el.textContent ?? '').trim())
    .find(Boolean);
  const show = document.querySelector<HTMLAnchorElement>('a[href*="/show/"]');
  return {
    videoId,
    title: h1 || parsed?.title || metaContent('og:title') || document.title.replace(/\s*[|｜].*$/, '').trim(),
    channel: parsed?.channel || (show?.textContent ?? '').trim(),
    duration: parsed?.duration ?? 0,
    url: location.href,
    tracks: [],
    audio: [],
    site: 'spotify',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

export default defineContentScript({
  matches: ['https://open.spotify.com/*'],
  runAt: 'document_idle',
  main() {
    serveEpisodePage({
      videoIdFromUrl: (url) => {
        const id = spotifyEpisodeIdFromUrl(url);
        return id ? `pod:sp:${id}` : null;
      },
      resolveMeta: async (videoId) => meta(videoId),
    });
  },
});
