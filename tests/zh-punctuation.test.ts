import { describe, expect, it } from 'vitest';
import { punctuateZh } from '../src/lib/zh-punctuation';

describe('punctuateZh', () => {
  it('adds a full stop to a Chinese cue without one', () => {
    expect(punctuateZh('今天聊一个话题')).toBe('今天聊一个话题。');
  });

  it('keeps existing terminal punctuation', () => {
    expect(punctuateZh('这是第二句。')).toBe('这是第二句。');
    expect(punctuateZh('真的吗？')).toBe('真的吗？');
  });

  it('replaces a cue-ending comma with a full stop', () => {
    expect(punctuateZh('来自播客的问候，')).toBe('来自播客的问候。');
  });

  it('chooses a question mark for question-shaped cues', () => {
    expect(punctuateZh('为什么会这样')).toBe('为什么会这样？');
    expect(punctuateZh('你听懂了吗')).toBe('你听懂了吗？');
  });

  it('inserts a comma before clear clause markers', () => {
    expect(punctuateZh('我们聊了很多但是时间不够')).toBe('我们聊了很多，但是时间不够。');
    expect(punctuateZh('也就是说这件事没那么简单')).toBe('也就是说这件事没那么简单。');
  });

  it('does not break 不过分 / 不过于', () => {
    expect(punctuateZh('这样做不过分')).toBe('这样做不过分。');
  });

  it('leaves non-Chinese text untouched', () => {
    expect(punctuateZh('Hello there, this is English')).toBe('Hello there, this is English');
    expect(punctuateZh('12345')).toBe('12345');
  });

  it('trims surrounding whitespace on Chinese cues', () => {
    expect(punctuateZh('  这是第二句  ')).toBe('这是第二句。');
  });

  it('returns an empty string unchanged', () => {
    expect(punctuateZh('')).toBe('');
  });
});
