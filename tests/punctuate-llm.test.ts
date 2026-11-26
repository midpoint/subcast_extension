import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Segment } from '../src/lib/types';

vi.mock('../src/lib/llm', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/llm')>();
  return { ...real, llmJson: vi.fn() };
});

import { llmJson } from '../src/lib/llm';
import { punctuateItems } from '../src/lib/punctuate';

const cfg = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat' };
const segs = (texts: string[]): Segment[] => texts.map((text, i) => ({ start: i, end: i + 1, text }));
const mock = vi.mocked(llmJson);

beforeEach(() => mock.mockReset());

describe('punctuateItems', () => {
  it('only asks about lines without trailing punctuation and applies the answers', async () => {
    mock.mockResolvedValueOnce({ t: [{ id: 0, text: '第一句。' }, { id: 2, text: '第三句？' }] });
    const res = await punctuateItems(segs(['a', 'b', 'c']), ['第一句', '第二句。', '第三句'], { cfg });
    expect(res.items).toEqual(['第一句。', '第二句。', '第三句？']);
    expect(res.changed).toBe(2);
    expect(mock).toHaveBeenCalledTimes(1);
    const payload = mock.mock.calls[0][2] as { lines: { id: number }[] };
    expect(payload.lines.map((l) => l.id)).toEqual([0, 2]);
  });

  it('keeps the original line when the model changed a character, even after one retry', async () => {
    mock.mockResolvedValueOnce({ t: [{ id: 0, text: '改写的句子。' }, { id: 2, text: '第三句？' }] });
    mock.mockResolvedValueOnce({ t: [{ id: 0, text: '还是改写的。' }] });
    const res = await punctuateItems(segs(['a', 'b', 'c']), ['第一句', '第二句。', '第三句'], { cfg });
    expect(res.items).toEqual(['第一句', '第二句。', '第三句？']);
    expect(res.changed).toBe(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('fails when the model rewrites every line', async () => {
    mock.mockResolvedValue({ t: [{ id: 0, text: '完全改写了。' }] });
    await expect(punctuateItems(segs(['a']), ['第一句'], { cfg })).rejects.toThrow();
  });

  it('does nothing when every line is already punctuated', async () => {
    const res = await punctuateItems(segs(['a']), ['第一句。'], { cfg });
    expect(res).toEqual({ items: ['第一句。'], changed: 0, failed: 0 });
    expect(mock).not.toHaveBeenCalled();
  });
});
