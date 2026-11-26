/** One place that decides which media a tab URL refers to. YouTube keeps its bare 11-character id
 *  everywhere; Xiaoyuzhou uses `qm:<eid>` (the desktop app's key), the other podcast sites use
 *  `pod:<site>:<id>`, and X video posts use `x:<statusId>`. */
import { appleEpisodeIdFromUrl } from './apple';
import { spotifyEpisodeIdFromUrl } from './spotify';
import type { SiteId } from './types';
import { xStatusIdFromUrl } from './x';
import { episodeIdFromUrl } from './xiaoyuzhou';
import { ximalayaSoundIdFromUrl } from './ximalaya';

function validYoutubeId(id: string | null | undefined): string | null {
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function siteFromUrl(url: string): SiteId | null {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)youtube\.com$/.test(host)) return 'youtube';
    if (/(^|\.)xiaoyuzhoufm\.com$/.test(host)) return 'xiaoyuzhou';
    if (/(^|\.)podcasts\.apple\.com$/.test(host)) return 'apple';
    if (/(^|\.)ximalaya\.com$/.test(host)) return 'ximalaya';
    if (/(^|\.)spotify\.com$/.test(host)) return 'spotify';
    if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  } catch {
    /* not a URL yet (about:blank, chrome://…) */
  }
  return null;
}

export function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') return validYoutubeId(u.searchParams.get('v'));
      if (u.pathname.startsWith('/shorts/')) return validYoutubeId(u.pathname.split('/')[2]);
      if (u.pathname.startsWith('/live/')) return validYoutubeId(u.pathname.split('/')[2]);
    }
    const xId = xStatusIdFromUrl(url);
    if (xId) return `x:${xId}`;
    const eid = episodeIdFromUrl(url);
    if (eid) return `qm:${eid}`;
    const appleId = appleEpisodeIdFromUrl(url);
    if (appleId) return `pod:ap:${appleId}`;
    const ximalayaId = ximalayaSoundIdFromUrl(url);
    if (ximalayaId) return `pod:xm:${ximalayaId}`;
    const spotifyId = spotifyEpisodeIdFromUrl(url);
    if (spotifyId) return `pod:sp:${spotifyId}`;
    return null;
  } catch {
    return null;
  }
}

export function isPodcastId(videoId: string | null | undefined): boolean {
  return Boolean(videoId && (videoId.startsWith('qm:') || videoId.startsWith('pod:')));
}
