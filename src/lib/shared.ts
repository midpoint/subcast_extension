/** subcast.qiaomu.ai shared transcripts. Lookups are silent (a network problem just means
 *  "fetch it yourself"); uploads happen only for cloud ASR results and only when the user keeps
 *  the sharing switch on. Only subtitle text and its translation are sent — never audio. */
import type { EpisodeRecord, Segment } from './types';

const API = 'https://subcast.qiaomu.ai/api/v1';

export interface SharedTranslation {
  lang: string;
  engine?: string;
  model?: string;
  items: (string | null)[];
}

export interface SharedTranscript {
  id: string;
  source: string;
  language: string;
  segments: Segment[];
  translation: SharedTranslation | null;
}

function qs(keys: string[]): string {
  return keys.map((k) => `key=${encodeURIComponent(k)}`).join('&');
}

export async function lookupTranscript(keys: string[]): Promise<SharedTranscript | null> {
  if (!keys.length) return null;
  try {
    const res = await fetch(`${API}/transcripts?${qs(keys)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const hit = (await res.json()) as SharedTranscript;
    if (!Array.isArray(hit.segments) || !hit.segments.length) return null;
    hit.segments = hit.segments.filter(
      (s) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && typeof s?.text === 'string' && s.text.trim() !== '',
    );
    if (!hit.segments.length) return null;
    if (hit.translation && !Array.isArray(hit.translation.items)) hit.translation = null;
    return hit;
  } catch {
    return null;
  }
}

export async function lookupGuide(keys: string[]): Promise<{ text: string; createdAt?: number } | null> {
  if (!keys.length) return null;
  try {
    const res = await fetch(`${API}/guides?${qs(keys)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const hit = (await res.json()) as { text?: string; createdAt?: number };
    return hit.text?.trim() ? { text: hit.text, createdAt: hit.createdAt } : null;
  } catch {
    return null;
  }
}

export async function exists(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  try {
    const res = await fetch(`${API}/transcripts/exists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { found?: string[] }).found ?? [];
  } catch {
    return [];
  }
}

export interface UploadOptions {
  installId: string;
  appVersion: string;
}

/** Upload a cloud-ASR transcript plus whatever Chinese translation exists. */
export async function uploadTranscript(ep: EpisodeRecord, opts: UploadOptions): Promise<{ action: string; id: string | null } | null> {
  if (!ep.segments.length) return null;
  const lastEnd = ep.segments[ep.segments.length - 1]?.end ?? 0;
  const duration = Math.max(ep.duration || 0, lastEnd + 1);
  const translated = ep.translation?.items.filter((x) => x != null).length ?? 0;
  const includeTranslation = ep.translation != null && translated >= ep.segments.length * 0.6;
  const translation = includeTranslation
    ? {
        lang: ep.translation!.lang,
        engine: ep.translation!.engine,
        model: ep.translation!.model,
        items: normalizeItems(ep.translation!.items, ep.segments.length),
      }
    : undefined;
  const body = {
    keys: [ep.key],
    title: ep.title.slice(0, 300),
    show: ep.channel.slice(0, 300),
    duration,
    // Only cloud ASR results are uploaded by the extension; never claim whisper/qwen3.
    source: 'cloud',
    model: (ep.asrModel || 'whisper-1').slice(0, 100),
    language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(ep.language) ? ep.language : 'auto',
    segments: ep.segments,
    ...(translation ? { translation } : {}),
    client: { app: 'subcast-extension', version: opts.appVersion, install: opts.installId },
  };
  try {
    const res = await fetch(`${API}/transcripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn('[subcast] shared upload failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const out = (await res.json()) as { action?: string; id?: string | null };
    return { action: out.action ?? '', id: out.id ?? null };
  } catch (e) {
    console.warn('[subcast] shared upload failed', e);
    return null;
  }
}

function normalizeItems(items: (string | null)[], n: number): (string | null)[] {
  const out: (string | null)[] = items.slice(0, n);
  while (out.length < n) out.push(null);
  return out;
}
