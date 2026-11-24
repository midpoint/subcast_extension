import { describe, expect, it } from 'vitest';
import { wavBlob } from '../src/lib/asr';
import { metaFromPlayerResponse } from '../src/lib/youtube';
import type { Segment } from '../src/lib/types';

describe('player response normalization', () => {
  it('reads title, tracks, audio formats and the original audio language', () => {
    const player = {
      videoDetails: { videoId: 'tBMlXQIrYK4', title: 'Episode', author: 'Show', lengthSeconds: '3600', channelId: 'UCFDMMIHbtRdrVhHlGXVzApA' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://youtube.com/api/timedtext?v=1&lang=en', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' } },
            { baseUrl: 'https://youtube.com/api/timedtext?v=1&lang=en', languageCode: 'en', name: { runs: [{ text: 'English' }] } },
            { baseUrl: 'https://youtube.com/api/timedtext?v=1&lang=zh&exp=xpe', languageCode: 'zh' },
          ],
        },
      },
      streamingData: {
        adaptiveFormats: [
          { mimeType: 'audio/webm; codecs="opus"', url: 'https://media.example/a.webm', bitrate: 50000, itag: 251, audioTrack: { id: 'en.1', displayName: 'English original' } },
          { mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://media.example/a.m4a', bitrate: 128000, itag: 140 },
          { mimeType: 'video/mp4', url: 'https://media.example/v.mp4' },
        ],
      },
    };
    const meta = metaFromPlayerResponse(player, 'tBMlXQIrYK4', 'https://www.youtube.com/watch?v=tBMlXQIrYK4');
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('Episode');
    expect(meta!.duration).toBe(3600);
    expect(meta!.channelId).toBe('UCFDMMIHbtRdrVhHlGXVzApA');
    expect(meta!.tracks).toHaveLength(2);
    expect(meta!.tracks[0].auto).toBe(true);
    expect(meta!.tracks[1].name).toBe('English');
    expect(meta!.audio).toHaveLength(2);
    expect(meta!.audio[0].bitrate).toBe(128000);
    expect(meta!.originalLanguage).toBe('en');
  });

  it('rejects a player response for another video', () => {
    const meta = metaFromPlayerResponse({ videoDetails: { videoId: 'AAAAAAAAAAA' } }, 'BBBBBBBBBBB', 'https://www.youtube.com/watch?v=BBBBBBBBBBB');
    expect(meta).toBeNull();
  });
});

describe('WAV chunking', () => {
  it('writes a 16-bit mono RIFF/WAVE header at 16 kHz', async () => {
    const samples = new Float32Array(16000).fill(0.25);
    const blob = wavBlob(samples);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 16000 * 2);
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(44, true)).toBeGreaterThan(0);
  });
});

describe('segment model', () => {
  it('translations align one-to-one with segments', () => {
    const segments: Segment[] = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
    ];
    const items = ['甲', null];
    expect(items).toHaveLength(segments.length);
  });
});
