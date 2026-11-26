/** Spotify episode pages. Audio is DRM-protected, so there is nothing the extension can transcribe;
 *  the page script only reports enough metadata for the panel to explain that clearly. */

export function spotifyEpisodeIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
    return u.pathname.match(/^\/(?:embed\/)?episode\/([A-Za-z0-9]{10,40})(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** ISO 8601 duration (`PT1H12M19S`, as Spotify's JSON-LD writes it) in seconds. */
export function parseIsoDuration(value: string): number {
  const m = value
    .trim()
    .match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Math.round(Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0));
}

/** Finds the PodcastEpisode node in Spotify's JSON-LD (which may be an array or an @graph). */
export function pickSpotifyEpisode(jsonld: unknown): { title: string; channel: string; duration: number } | null {
  const nodes: any[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const obj = v as any;
      nodes.push(obj);
      if (obj['@graph']) walk(obj['@graph']);
    }
  };
  walk(jsonld);
  const ep = nodes.find((n) => {
    const type = n['@type'];
    return type === 'PodcastEpisode' || (Array.isArray(type) && type.includes('PodcastEpisode'));
  });
  if (!ep) return null;
  const series = Array.isArray(ep.partOfSeries) ? ep.partOfSeries[0] : ep.partOfSeries;
  return {
    title: typeof ep.name === 'string' ? ep.name : '',
    channel: typeof series?.name === 'string' ? series.name : '',
    duration: typeof ep.timeRequired === 'string' ? parseIsoDuration(ep.timeRequired) : 0,
  };
}
