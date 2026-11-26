/** Chinese subtitle punctuation. Google (and some models) translates cue by cue, so the Chinese
 *  lines often arrive without sentence punctuation; the user's own model adds it afterwards. The
 *  model may only touch punctuation — a line is kept only when every character survived. */
import { llmJson } from './llm';
import { batchShape, salvage } from './translate';
import type { LlmConfig, Segment } from './types';

const ENDS_IN_PUNCTUATION = /\p{P}$/u;

/** True when the line already ends in punctuation (a comma counts: the sentence goes on). */
export function endsWithPunctuation(text: string): boolean {
  return ENDS_IN_PUNCTUATION.test(text.trim());
}

/** The same characters once punctuation and spaces are ignored. */
export function bareText(text: string): string {
  return text.replace(/[\s\p{P}]/gu, '');
}

/** Lines worth a model look: translated, non-empty, and not ending in any punctuation. */
export function punctuationTargets(segments: Segment[], items: (string | null)[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const text = items[i]?.trim() ?? '';
    if (text && !endsWithPunctuation(text)) out.push(i);
  }
  return out;
}

/** Accepts the model's line only when it changed nothing but punctuation/whitespace. */
export function mergePunctuated(original: string, answer: string): string | null {
  const text = answer.trim();
  if (!text) return null;
  return bareText(text) === bareText(original) ? text : null;
}

export interface PunctuationShape {
  lines: number;
  chars: number;
  before: number;
  after: number;
}

/** Target ids in time order, split by line count and character budget. Punctuated lines between
 *  them are skipped instead of forcing a request per line, so a few gaps cost one batch. */
export function punctuationBatches(targets: number[], items: (string | null)[], shape: PunctuationShape): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  for (const id of targets) {
    if (cur.length && (cur.length >= shape.lines || size + (items[id] ?? '').length > shape.chars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(id);
    size += (items[id] ?? '').length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// i18n-ignore-start (prompt sent to the model)
export const PUNCTUATION_RULES = `你在给机器翻译得到的中文字幕补标点。输入 JSON 里 lines 是按时间顺序排列的字幕行，每行是一个 id 和一句中文。
规则：
1. 只能补充或调整标点符号（，。？！、；：……“”‘’等），中文一律用全角标点。除了标点，绝对不能增加、删除、改写、调换任何字、字母或数字。
2. 按语义断句：一个完整句子结束时用。？！；句子还没说完时用，或者不加句末标点；不要把一个词拆开。
3. 已经有标点且读起来通顺的行原样返回，不要为了加标点而改写。
4. contextBefore / contextAfter 只用来理解上下文，不要输出。
输出 ONLY：{"t":[{"id":number,"text":string}]}，每个 id 恰好一次。不要 Markdown。`;
// i18n-ignore-end

export interface PunctuateOptions {
  cfg: LlmConfig;
  signal?: AbortSignal;
  concurrency?: number;
  /** Called after every finished batch with a new aligned array. */
  onProgress?: (items: (string | null)[], done: number, total: number) => void;
}

export interface PunctuateResult {
  items: (string | null)[];
  changed: number;
  failed: number;
}

interface Payload {
  contextBefore: string[];
  lines: { id: number; text: string }[];
  contextAfter: string[];
}

function payloadFor(batch: number[], items: (string | null)[], shape: PunctuationShape): Payload {
  const first = batch[0];
  const last = batch[batch.length - 1];
  return {
    contextBefore: items.slice(Math.max(0, first - shape.before), first).map((t) => t ?? '').filter(Boolean),
    lines: batch.map((id) => ({ id, text: items[id] ?? '' })),
    contextAfter: items.slice(last + 1, last + 1 + shape.after).map((t) => t ?? '').filter(Boolean),
  };
}

/** One model call; returns only answers that kept every character. Missing ids are retried once. */
async function punctuateBatch(
  batch: number[],
  items: (string | null)[],
  shape: PunctuationShape,
  o: PunctuateOptions,
): Promise<Map<number, string>> {
  const read = (data: unknown, ids: number[]) => {
    const out = new Map<number, string>();
    for (const [id, text] of salvage(JSON.stringify(data), ids)) {
      const merged = mergePunctuated(items[id] ?? '', text);
      if (merged != null) out.set(id, merged);
    }
    return out;
  };
  const payload = payloadFor(batch, items, shape);
  const data = await llmJson<unknown>(o.cfg, PUNCTUATION_RULES, payload, 4000, o.signal);
  let got = read(data, batch);
  const missing = batch.filter((id) => !got.has(id));
  if (missing.length && missing.length < batch.length) {
    const again = await llmJson<unknown>(o.cfg, PUNCTUATION_RULES, payloadFor(missing, items, shape), 4000, o.signal);
    got = new Map([...got, ...read(again, missing)]);
  }
  return got;
}

/** Adds punctuation to the translated lines that still lack it. Never changes any other character. */
export async function punctuateItems(
  segments: Segment[],
  existing: (string | null)[],
  o: PunctuateOptions,
): Promise<PunctuateResult> {
  const items = existing.slice();
  const targets = punctuationTargets(segments, items);
  if (!targets.length) return { items, changed: 0, failed: 0 };
  const shape: PunctuationShape = { lines: Math.min(batchShape(o.cfg).lines, 24), chars: 1800, before: 2, after: 1 };
  const batches = punctuationBatches(targets, items, shape);
  let changed = 0;
  let failed = 0;
  let done = 0;
  let lastError: unknown = null;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (o.signal?.aborted) throw new DOMException('补标点已取消', 'AbortError');
      const batch = batches[next++];
      if (!batch) return;
      try {
        const got = await punctuateBatch(batch, items, shape, o);
        for (const [id, text] of got) {
          if (text !== items[id]) {
            items[id] = text;
            changed++;
          }
        }
        if (!got.size) failed++;
        done += batch.length;
        o.onProgress?.(items.slice(), done, targets.length);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        failed++;
        done += batch.length;
        lastError = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 2, Math.max(batches.length, 1)) }, worker));
  if (changed === 0 && failed && failed === batches.length) {
    throw lastError instanceof Error ? lastError : new Error('补标点失败');
  }
  return { items, changed, failed };
}
