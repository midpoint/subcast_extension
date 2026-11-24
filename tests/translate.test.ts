import { describe, expect, it } from 'vitest';
import {
  batchShape,
  buildBatches,
  needsTranslation,
  salvage,
  shouldTranslate,
} from '../src/lib/translate';
import type { Segment } from '../src/lib/types';

const segs = (texts: string[]): Segment[] => texts.map((text, i) => ({ start: i, end: i + 1, text }));

describe('translation batching', () => {
  it('skips translated lines and splits by count, size and gaps', () => {
    const segments = segs(['a', 'b', 'c', 'd', 'e']);
    const items = [null, '乙', null, null, null];
    expect(buildBatches(segments, items, { lines: 2, chars: 100, before: 1, after: 1 })).toEqual([[0], [2, 3], [4]]);
  });

  it('respects the character budget and keeps one long line whole', () => {
    const segments = segs(['x'.repeat(50), 'y'.repeat(50), 'z'.repeat(10)]);
    const batches = buildBatches(segments, [null, null, null], { lines: 99, chars: 60, before: 1, after: 1 });
    expect(batches).toEqual([[0], [1, 2]]);
  });

  it('uses smaller batches for local models and larger ones for DeepSeek', () => {
    expect(batchShape({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5' }).lines).toBe(10);
    expect(batchShape({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat' }).lines).toBe(30);
  });
});

describe('salvage', () => {
  it('reads the {"t":[…]} envelope', () => {
    const got = salvage('{"t":[{"id":1,"text":"一"},{"id":2,"text":"二"}]}', [1, 2]);
    expect([...got]).toEqual([
      [1, '一'],
      [2, '二'],
    ]);
  });

  it('reads a bare array and ignores ids outside the batch', () => {
    const got = salvage('[{"id":3,"text":"三"},{"id":9,"text":"九"}]', [3]);
    expect([...got]).toEqual([[3, '三']]);
  });

  it('still recovers entries from a cut-off answer', () => {
    const got = salvage('{"t":[{"id":4,"text":"四"},{"id":5,"text":"五"', [4, 5]);
    expect([...got]).toEqual([[4, '四']]);
  });
});

describe('translation need and target', () => {
  it('does not translate Chinese transcripts', () => {
    expect(shouldTranslate('zh')).toBe(false);
    expect(shouldTranslate('zh-Hans')).toBe(false);
    expect(shouldTranslate('en')).toBe(true);
    expect(shouldTranslate('en-US')).toBe(true);
  });

  it('needs translation when a non-empty line has no item', () => {
    const s = segs(['a', '', 'c']);
    expect(needsTranslation([null, null, null], s)).toBe(true);
    expect(needsTranslation(['甲', '', '丙'], s)).toBe(false);
    expect(needsTranslation(['甲', null, null], s)).toBe(true);
  });
});
