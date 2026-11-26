import { afterEach, describe, expect, it, vi } from 'vitest';
import { videoIdFromUrl, siteFromUrl } from '../src/lib/media';
import { isMediaSite, isPodcastSite } from '../src/lib/types';
import { fetchXPost, pickXMp4, syndicationToken, xStatusIdFromUrl } from '../src/lib/x';

describe('X post detection', () => {
  it('reads the status id from x.com and twitter.com URLs', () => {
    expect(xStatusIdFromUrl('https://x.com/elonmusk/status/1855234567890123456')).toBe('1855234567890123456');
    expect(xStatusIdFromUrl('https://twitter.com/user/status/1234567890')).toBe('1234567890');
    expect(xStatusIdFromUrl('https://x.com/i/status/1855234567890123456')).toBe('1855234567890123456');
    expect(xStatusIdFromUrl('https://x.com/user/status/1855234567890123456/video/1')).toBe('1855234567890123456');
    expect(xStatusIdFromUrl('https://x.com/user/status/1855234567890123456?s=20')).toBe('1855234567890123456');
  });

  it('ignores profile pages, non-numeric ids and other hosts', () => {
    expect(xStatusIdFromUrl('https://x.com/elonmusk')).toBeNull();
    expect(xStatusIdFromUrl('https://x.com/user/status/not-an-id')).toBeNull();
    expect(xStatusIdFromUrl('https://example.com/user/status/1234567890')).toBeNull();
    expect(xStatusIdFromUrl('not a url')).toBeNull();
  });

  it('routes X video posts through the site id and episode key', () => {
    expect(siteFromUrl('https://x.com/user/status/1855234567890123456')).toBe('x');
    expect(videoIdFromUrl('https://x.com/user/status/1855234567890123456')).toBe('x:1855234567890123456');
    expect(isMediaSite('x')).toBe(true);
    expect(isPodcastSite('x')).toBe(false);
  });

  it('computes the syndication token the web client uses', () => {
    expect(syndicationToken('1855234567890123456')).toBe('4hwe33zjsbh');
    expect(syndicationToken('20')).toBe('6dq1a2xwd93');
    expect(syndicationToken('1234567890')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('X video variants', () => {
  it('picks the highest-bitrate MP4 and ignores HLS playlists', () => {
    expect(
      pickXMp4({
        video: {
          variants: [
            { content_type: 'video/mp4', bitrate: 288000, src: 'https://video.twimg.com/a-small.mp4' },
            { content_type: 'video/mp4', bitrate: 2176000, src: 'https://video.twimg.com/a-large.mp4' },
            { content_type: 'application/x-mpegURL', src: 'https://video.twimg.com/a.m3u8' },
          ],
        },
      }),
    ).toBe('https://video.twimg.com/a-large.mp4');
  });

  it('accepts the older `type` field and returns null without an MP4', () => {
    expect(
      pickXMp4({ video: { variants: [{ type: 'video/mp4', src: 'https://video.twimg.com/legacy.mp4' }] } }),
    ).toBe('https://video.twimg.com/legacy.mp4');
    expect(pickXMp4({ video: { variants: [{ content_type: 'application/x-mpegURL', src: 'https://x/a.m3u8' }] } })).toBeNull();
    expect(pickXMp4({})).toBeNull();
  });
});

describe('fetchXPost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the syndication endpoint and returns the post media', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          text: 'A short video about   AI infra',
          user: { name: 'Someone', screen_name: 'someone' },
          video: {
            durationMs: 42_500,
            variants: [
              { content_type: 'video/mp4', bitrate: 832000, src: 'https://video.twimg.com/amplify_video/1234567890/vid/avc1/640x360/a.mp4' },
              { content_type: 'application/x-mpegURL', src: 'https://video.twimg.com/amplify_video/1234567890/pl/a.m3u8' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ep = await fetchXPost('1700000000000000001');
    expect(ep).toEqual({
      title: 'A short video about AI infra',
      channel: 'Someone (@someone)',
      duration: 43,
      audioUrl: 'https://video.twimg.com/amplify_video/1234567890/vid/avc1/640x360/a.mp4',
    });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('https://cdn.syndication.twimg.com/tweet-result?id=1700000000000000001');
    expect(url).toContain('token=');

    // The second lookup is served from the ten-minute cache.
    await fetchXPost('1700000000000000001');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the post has no progressive MP4', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ text: 'no video', video: { variants: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(await fetchXPost('1700000000000000002')).toBeNull();
  });

  it('reports HTTP failures instead of pretending there is no video', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));
    await expect(fetchXPost('1700000000000000003')).rejects.toThrow(/HTTP 429/);
  });
});
