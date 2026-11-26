/** Xiaoyuzhou (小宇宙) episode pages. There are no subtitle tracks to download: the side panel asks
 *  for cloud ASR, so this script only reports the episode's metadata and the audio playback state,
 *  and lets the panel seek the page's own player. */
import { serveEpisodePage } from '../src/lib/episode-page';
import type { VideoMeta } from '../src/lib/types';
import { episodeIdFromUrl, episodeMetaFromHtml, episodeMetaFromNextData } from '../src/lib/xiaoyuzhou';

/** The site renders a hidden trial-end cue as a second `<audio>`; use the episode one. */
function mainAudio(): HTMLAudioElement | null {
  const list = Array.from(document.querySelectorAll('audio'));
  return list.find((a) => a.src && !a.src.includes('/static/audio/')) ?? list[0] ?? null;
}

function fallbackMeta(eid: string): VideoMeta {
  const audio = mainAudio();
  const src = audio?.src || audio?.currentSrc || '';
  return {
    videoId: `qm:${eid}`,
    title: document.title.replace(/\s*[|｜]\s*小宇宙.*$/, '').trim(),
    channel: '',
    duration: Number.isFinite(audio?.duration) ? audio!.duration : 0,
    url: location.href,
    tracks: [],
    audio: [],
    audioUrl: /^https?:\/\//.test(src) ? src : undefined,
    site: 'xiaoyuzhou',
    capturedAt: Date.now(),
    origin: 'page',
  };
}

async function resolveMeta(videoId: string): Promise<VideoMeta> {
  const eid = videoId.replace(/^qm:/, '');
  const el = document.getElementById('__NEXT_DATA__');
  if (el?.textContent) {
    try {
      const m = episodeMetaFromNextData(JSON.parse(el.textContent), location.href);
      if (m?.videoId === `qm:${eid}`) return m;
    } catch {
      /* fall through to a fresh page fetch */
    }
  }
  // In-page navigation keeps the first page's JSON; fetch this episode's server-rendered page.
  try {
    const res = await fetch(location.href, { credentials: 'same-origin', signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const m = episodeMetaFromHtml(await res.text(), location.href);
      if (m?.videoId === `qm:${eid}`) return m;
    }
  } catch {
    /* use what the DOM tells us */
  }
  return fallbackMeta(eid);
}

export default defineContentScript({
  matches: ['https://www.xiaoyuzhoufm.com/*'],
  runAt: 'document_idle',
  main() {
    serveEpisodePage({
      videoIdFromUrl: (url) => {
        const eid = episodeIdFromUrl(url);
        return eid ? `qm:${eid}` : null;
      },
      resolveMeta,
      player: mainAudio,
    });
  },
});
