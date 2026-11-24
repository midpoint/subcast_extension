/** Subtitle formats and clean-up, ported from the desktop app's crates/subcast-core/src/transcript.rs
 *  and youtube.rs. Keeping one parser means a shared transcript, a YouTube track and a cloud ASR
 *  result all produce the same `{start,end,text}` segments. */
import type { CaptionTrack, Segment } from './types';

function parseStamp(stamp: string): number | null {
  const parts = stamp.trim().replace(',', '.').split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    const n = Number(p.trim());
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (_m, hex: string, num: string) => {
      const n = parseInt(num, hex ? 16 : 10);
      try {
        return Number.isFinite(n) ? String.fromCodePoint(n) : '';
      } catch {
        return '';
      }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, '')).split(/\s+/).filter(Boolean).join(' ');
}

/** WebVTT and SRT share the `start --> end` cue line. */
export function parseCues(body: string): Segment[] {
  const out: Segment[] = [];
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, bRaw] = lines[idx].split('-->');
    if (a == null || bRaw == null) continue;
    const b = bRaw.trim().split(/\s+/)[0] ?? '';
    const start = parseStamp(a);
    const end = parseStamp(b);
    if (start == null || end == null) continue;
    const text = stripTags(lines.slice(idx + 1).join(' '));
    if (text) out.push({ start, end, text });
  }
  return out;
}

/** Podcasting 2.0 JSON transcript: {"segments":[{"startTime":..,"endTime":..,"body":".."}]} */
export function parsePodcastJson(body: string): Segment[] {
  try {
    const v = JSON.parse(body) as { segments?: { startTime?: number; endTime?: number; body?: string }[] };
    return (v.segments ?? [])
      .map((s) => {
        const text = (s.body ?? '').trim();
        const start = Number(s.startTime);
        const end = Number(s.endTime);
        if (!text || !Number.isFinite(start)) return null;
        return { start, end: Number.isFinite(end) ? end : start + 2, text };
      })
      .filter((s): s is Segment => s != null);
  } catch {
    return [];
  }
}

/** YouTube timedtext: json3 events, or srv3/classic XML. */
export function parseYoutube(body: string): Segment[] {
  const trimmed = body.trim();
  const out: Segment[] = [];
  if (trimmed.startsWith('{')) {
    try {
      const v = JSON.parse(trimmed) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
      for (const ev of v.events ?? []) {
        if (typeof ev.tStartMs !== 'number') continue;
        const d = ev.dDurationMs ?? 0;
        const text = stripTags((ev.segs ?? []).map((s) => s.utf8 ?? '').join(''));
        if (text) out.push({ start: ev.tStartMs / 1000, end: (ev.tStartMs + d) / 1000, text });
      }
    } catch {
      /* not json3 */
    }
    return out;
  }
  const pRe = /<(text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/g;
  const aRe = /\b(start|dur|t|d)="([\d.]+)"/g;
  for (const c of trimmed.matchAll(pRe)) {
    const classic = c[1] === 'text';
    let start: number | null = null;
    let dur = 0;
    for (const a of c[2].matchAll(aRe)) {
      const v = Number(a[2]);
      if (!Number.isFinite(v)) continue;
      if (a[1] === 'start' && classic) start = v;
      else if (a[1] === 'dur' && classic) dur = v;
      else if (a[1] === 't' && !classic) start = v / 1000;
      else if (a[1] === 'd' && !classic) dur = v / 1000;
    }
    const text = stripTags(c[3]);
    if (start != null && text) out.push({ start, end: start + dur, text });
  }
  return out;
}

const HALLUCINATIONS = [
  '谢谢观看', '感谢观看', '请不吝点赞', '字幕由', '字幕by', '订阅', 'thanks for watching',
  'thank you for watching', 'subtitles by', 'amara.org',
];

/** Drops music cues and the lines Whisper tends to invent over silence. */
export function clean(segments: Segment[]): Segment[] {
  const musicRe = /^\s*[\[\(（【]?\s*(music|音乐|applause|掌声|laughter|笑声|♪+)\s*[\]\)）】]?\s*$/i;
  const out: Segment[] = [];
  for (const s of segments) {
    const text = s.text.replace(/♪/g, '').replace('[]', '').replace('()', '').trim();
    if (!text || musicRe.test(text)) continue;
    const low = text.toLowerCase();
    if (s.end - s.start < 4 && text.length < 30 && HALLUCINATIONS.some((h) => low.includes(h))) continue;
    if (out.length && out[out.length - 1].text === text) continue;
    out.push({ ...s, text });
  }
  return out;
}

const endsSentence = (t: string) => /[.?!。？！…"”]$/.test(t.trimEnd());

/** Joins caption fragments into sentence-sized blocks at sentence ends, long pauses, or a size limit. */
export function resegment(segments: Segment[]): Segment[] {
  const punctuated = segments.filter((s) => endsSentence(s.text)).length * 6 >= Math.max(segments.length, 1);
  const [maxLen, maxSecs] = punctuated ? [320, 30] : [180, 12];
  const out: Segment[] = [];
  let cur: Segment | null = null;
  const isCjk = (t: string) => {
    const cp = t.codePointAt(0) ?? 0;
    return cp > 0x2e80;
  };
  for (const s of segments) {
    if (cur) {
      const gap = s.start - cur.end;
      const tooLong = cur.text.length > maxLen || s.end - cur.start > maxSecs;
      if ((punctuated && endsSentence(cur.text) && cur.end - cur.start > 1.2) || gap > 2 || tooLong) {
        out.push(cur);
        cur = { ...s };
      } else {
        if (!isCjk(s.text)) cur.text += ' ';
        cur.text += s.text;
        cur.end = Math.max(cur.end, s.end);
      }
    } else {
      cur = { ...s };
    }
  }
  if (cur) out.push(cur);
  // Auto captions run into the next cue; trim their end times.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  }
  return out;
}

/** Splits a block of text with one time range into sentences, spreading time by length. */
export function splitTimed(text: string, start: number, end: number): Segment[] {
  const chars = [...text];
  const raw: string[] = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    cur += c;
    const next = chars[i + 1];
    let ends = false;
    if (c === '。' || c === '？' || c === '！' || c === '；') ends = next !== '”' && next !== '"';
    else if (c === '.' || c === '?' || c === '!') ends = next == null || /\s/.test(next);
    else if (c === '"' || c === '”') ends = i > 0 && ['.', '?', '!', '。', '？', '！'].includes(chars[i - 1]);
    if (ends) {
      raw.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) raw.push(cur.trim());
  const short = (t: string) => t.length < (t.codePointAt(0)! > 0x2e80 ? 6 : 12);
  const parts: string[] = [];
  for (const r of raw.filter(Boolean)) {
    const last = parts[parts.length - 1];
    if (last != null && (short(r) || short(last))) {
      const cp = last.codePointAt(last.length - 1) ?? 0;
      if (cp <= 0x2e80) parts[parts.length - 1] += ' ';
      parts[parts.length - 1] += r;
    } else {
      parts.push(r);
    }
  }
  const total = Math.max(parts.reduce((n, p) => n + p.length, 0), 1);
  const span = Math.max(end - start, 0);
  let t = start;
  return parts.map((p) => {
    const d = (span * p.length) / total;
    const s = { start: t, end: t + d, text: p };
    t += d;
    return s;
  });
}

const baseLang = (lang: string) => (lang.split(/[-_]/)[0] ?? lang).toLowerCase();

/** The language a title is most likely spoken in, from its script. */
export function scriptHint(title: string): string | null {
  const has = (lo: number, hi: number) => [...title].some((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= lo && cp <= hi;
  });
  if (has(0x3040, 0x30ff)) return 'ja';
  if (has(0xac00, 0xd7af)) return 'ko';
  if ([...title].filter((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0x4e00 && cp <= 0x9fff;
  }).length >= 2) return 'zh';
  return null;
}

/** The track to show: a human-made one in the spoken language, else the auto track in it, else English. */
export function chooseTrack(tracks: CaptionTrack[], originalLanguage?: string | null, title = ''): CaptionTrack | null {
  if (!tracks.length) return null;
  const autos = tracks.filter((t) => t.auto);
  const spoken =
    (originalLanguage && baseLang(originalLanguage)) ||
    (autos.length === 1 ? baseLang(autos[0].language) : null) ||
    scriptHint(title);
  if (spoken) {
    const manual = tracks.find((t) => !t.auto && baseLang(t.language) === spoken);
    if (manual) return manual;
    const auto = autos.find((t) => baseLang(t.language) === spoken);
    if (auto) return auto;
  }
  return (
    tracks.find((t) => !t.auto && baseLang(t.language) === 'en') ??
    autos.find((t) => baseLang(t.language) === 'en') ??
    tracks.find((t) => !t.auto) ??
    tracks[0] ??
    null
  );
}

/** Candidate tracks in preference order, so a broken first track doesn't mean "no subtitles". */
export function trackCandidates(tracks: CaptionTrack[], originalLanguage?: string | null, title = ''): CaptionTrack[] {
  const first = chooseTrack(tracks, originalLanguage, title);
  if (!first) return [];
  return [first, ...tracks.filter((t) => t !== first)].slice(0, 4);
}

/** `clock` for the UI: [mm:ss] under an hour, [h:mm:ss] above. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Index of the line playing at `time` (binary search, like the desktop panel). */
export function activeIndex(segments: Segment[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time + 0.15) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Timestamp ranges in model output, e.g. [12:34] or [12:34]-[13:20], become seekable in the UI. */
export const TIMESTAMP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\s*[-–—]\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\])?/g;

export function parseClock(text: string): number {
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
