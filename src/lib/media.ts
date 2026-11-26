/** One place that decides which media a tab URL refers to. YouTube keeps its bare 11-character id
 *  everywhere; a Xiaoyuzhou episode becomes `qm:<eid>`, the key the desktop app also uses. */
import { episodeIdFromUrl } from './xiaoyuzhou';

function validYoutubeId(id: string | null | undefined): string | null {
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') return validYoutubeId(u.searchParams.get('v'));
      if (u.pathname.startsWith('/shorts/')) return validYoutubeId(u.pathname.split('/')[2]);
      if (u.pathname.startsWith('/live/')) return validYoutubeId(u.pathname.split('/')[2]);
    }
    const eid = episodeIdFromUrl(url);
    return eid ? `qm:${eid}` : null;
  } catch {
    return null;
  }
}

export function isPodcastId(videoId: string | null | undefined): boolean {
  return Boolean(videoId?.startsWith('qm:'));
}
