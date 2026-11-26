import { describe, expect, it } from 'vitest';
import { endsWithPunctuation, mergePunctuated, punctuationBatches, punctuationTargets } from '../src/lib/punctuate';
import type { Segment } from '../src/lib/types';

const segs = (texts: string[]): Segment[] => texts.map((text, i) => ({ start: i, end: i + 1, text }));

describe('punctuation targets', () => {
  it('treats any trailing punctuation, including a closing quote, as punctuated', () => {
    expect(endsWithPunctuation('我们今天去了公园。')).toBe(true);
    expect(endsWithPunctuation('他说“走吧”')).toBe(true);
    expect(endsWithPunctuation('我们先回去，')).toBe(true);
    expect(endsWithPunctuation('我们今天去了公园')).toBe(false);
    expect(endsWithPunctuation('   ')).toBe(false);
  });

  it('only targets translated, non-empty lines without trailing punctuation', () => {
    const segments = segs(['source a', 'source b', 'source c', '']);
    expect(punctuationTargets(segments, [null, '你好', '在吗？', ''])).toEqual([1]);
  });
});

describe('mergePunctuated', () => {
  it('accepts answers that only added punctuation', () => {
    expect(mergePunctuated('真的吗', '真的吗？')).toBe('真的吗？');
    expect(mergePunctuated('我们今天去了公园', '我们今天，去了公园。')).toBe('我们今天，去了公园。');
  });

  it('rejects rewritten, reordered or shortened lines', () => {
    expect(mergePunctuated('我们今天去了公园', '今天我们去了公园。')).toBeNull();
    expect(mergePunctuated('今天很冷', '今天很热。')).toBeNull();
    expect(mergePunctuated('我们今天去了公园', '我们今天。')).toBeNull();
  });

  it('keeps full-width punctuation from the model', () => {
    expect(mergePunctuated('第一点 第二点', '第一点；第二点。')).toBe('第一点；第二点。');
  });
});

describe('punctuation batching', () => {
  const items = ['一', '二', '三', '四', '五'];

  it('groups non-adjacent target lines instead of one request per gap', () => {
    expect(punctuationBatches([0, 1, 2, 3, 4], items, { lines: 2, chars: 100, before: 1, after: 1 })).toEqual([[0, 1], [2, 3], [4]]);
    expect(punctuationBatches([0, 3], items, { lines: 9, chars: 100, before: 1, after: 1 })).toEqual([[0, 3]]);
  });

  it('respects the character budget', () => {
    const long = ['x'.repeat(10), 'y'.repeat(10), 'z'.repeat(10)];
    expect(punctuationBatches([0, 1, 2], long, { lines: 9, chars: 20, before: 1, after: 1 })).toEqual([[0, 1], [2]]);
  });
});
