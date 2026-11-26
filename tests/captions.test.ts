import { describe, expect, it } from 'vitest';
import {
  activeIndex,
  chooseTrack,
  clean,
  clock,
  parseClock,
  parseCues,
  parseYoutube,
  resegment,
  scriptHint,
  splitTimed,
} from '../src/lib/captions';
import type { CaptionTrack, Segment } from '../src/lib/types';

const track = (language: string, auto = false): CaptionTrack => ({
  baseUrl: `https://example.com/${language}`,
  language,
  auto,
  name: language,
});

const seg = (start: number, end: number, text: string): Segment => ({ start, end, text });

describe('YouTube / WebVTT parsing', () => {
  it('parses json3 events and drops whitespace-only fragments', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello' }, { utf8: ' there' }] },
        { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Second' }] },
      ],
    });
    const got = parseYoutube(body);
    expect(got).toEqual([seg(0, 1.5, 'Hello there'), seg(2, 4, 'Second')]);
  });

  it('parses srv3 XML with entities', () => {
    const got = parseYoutube(
      '<timedtext><body><p t="320" d="1000">[Music]</p><p t="18800" d="7160"><s>We&#39;re</s><s t="239"> no</s></p></body></timedtext>',
    );
    expect(got).toHaveLength(2);
    expect(got[1].text).toBe("We're no");
    expect(clean(got)).toHaveLength(1);
  });

  it('parses WebVTT and SRT cue clocks', () => {
    const got = parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Joe>Hello there.\n\n2\n00:01:02,000 --> 00:01:04,000\nNext');
    expect(got).toEqual([seg(1, 3.5, 'Hello there.'), seg(62, 64, 'Next')]);
  });
});

describe('sentence clean-up', () => {
  it('merges caption fragments and trims overlapping auto-caption ends', () => {
    const merged = resegment([
      seg(0, 2, 'so what we found'),
      seg(2, 4, 'is that it works'),
      seg(10, 12, 'next idea'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('so what we found is that it works');
  });

  it('splits a timed block by sentence and spreads time by length', () => {
    const got = splitTimed('This is the first sentence. And a second one here? Yes. 第三句中文内容在这里。', 10, 40);
    expect(got).toHaveLength(3);
    expect(got[1].text).toBe('And a second one here? Yes.');
    expect(got[0].start).toBeCloseTo(10);
    expect(got[2].end).toBeCloseTo(40);
  });

  it('drops Whisper hallucination lines and music cues', () => {
    const got = clean([
      seg(0, 2, '[Music]'),
      seg(2, 4, '♪♪'),
      seg(4, 5, 'Thanks for watching!'),
      seg(5, 8, 'Real content here.'),
      seg(8, 10, 'Real content here.'),
    ]);
    expect(got.map((s) => s.text)).toEqual(['Real content here.']);
  });
});

describe('track choice', () => {
  it('prefers the spoken language, then English', () => {
    const tracks = [track('ar', true), track('en', true), track('en-US'), track('de', true)];
    expect(chooseTrack(tracks, 'en')?.language).toBe('en-US');
    expect(chooseTrack(tracks)?.language).toBe('en-US');
    expect(chooseTrack([track('ja', true)])?.language).toBe('ja');
  });

  it('uses the title script so a Chinese show with English subtitles opens in Chinese', () => {
    const tracks = [track('en'), track('zh-Hans'), track('zh-Hans', true), track('en', true)];
    expect(scriptHint('#010 黄仁勋辞职，语言即世界')).toBe('zh');
    expect(chooseTrack(tracks, undefined, '#010 黄仁勋辞职，语言即世界')?.language).toBe('zh-Hans');
    expect(scriptHint('Recursive self-improvement has started')).toBeNull();
    expect(scriptHint('ChatGPTの使い方')).toBe('ja');
  });

  it('follows the audio language when a dubbed video has an English title and several auto tracks', () => {
    const tracks = [track('en', true), track('zh-Hans', true), track('es', true)];
    expect(chooseTrack(tracks, 'zh-Hans', 'How I cook rice at home')?.language).toBe('zh-Hans');
    expect(chooseTrack(tracks, 'en', 'How I cook rice at home')?.language).toBe('en');
  });
});

describe('clocks and active line', () => {
  it('formats and parses timestamps', () => {
    expect(clock(9)).toBe('0:09');
    expect(clock(754)).toBe('12:34');
    expect(clock(3723)).toBe('1:02:03');
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('12:34')).toBe(754);
  });

  it('finds the line playing at a time', () => {
    const segs = [seg(0, 2, 'a'), seg(2, 5, 'b'), seg(10, 12, 'c')];
    expect(activeIndex(segs, 0)).toBe(0);
    expect(activeIndex(segs, 3)).toBe(1);
    expect(activeIndex(segs, 9)).toBe(1);
    expect(activeIndex(segs, 11)).toBe(2);
    expect(activeIndex([], 1)).toBe(-1);
  });
});
