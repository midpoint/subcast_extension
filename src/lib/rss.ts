/** Minimal RSS 2.0 helpers for podcast feeds. The MV3 service worker has no DOMParser, so this is
 *  regex-based; it only needs the handful of fields podcast feeds put on one line or in CDATA. */

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the XML entities podcast feeds actually use. `&amp;` is decoded last so that a feed which
 *  double-escaped a URL (`&amp;amp;`) keeps the second entity instead of turning it into `&`. */
export function decodeEntities(s: string): string {
  const codepoint = (n: number) => {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    try {
      return String.fromCodePoint(n);
    } catch {
      return '';
    }
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codepoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codepoint(Number(dec)))
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED[name])
    .replace(/&amp;/g, '&');
}

/** Text content of a tag body: strips one CDATA wrapper and trims surrounding whitespace. */
export function xmlText(raw: string | null | undefined): string {
  if (!raw) return '';
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities((cdata ? cdata[1] : raw).trim()).trim();
}

export function rssItems(xml: string): string[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1] ?? '');
}

export function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return xmlText(m?.[1]);
}

/** Reads an attribute from a self-closing or paired element, e.g. `<enclosure url="…" />`. */
export function tagAttr(block: string, tag: string, attr: string): string {
  const el = block.match(new RegExp(`<${tag}\\b([^>]*)>`, 'i'));
  if (!el) return '';
  const m = el[1].match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return xmlText(m?.[1] ?? m?.[2] ?? '');
}

/** `1:12:19`, `12:19` or a plain number of seconds. Returns 0 when the value is not understood. */
export function parseDuration(value: string): number {
  const s = value.trim();
  if (!s) return 0;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return 0;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0));
}
