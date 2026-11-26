import { describe, expect, it } from 'vitest';
import { appleUrlInfo, pickAppleEpisode } from '../src/lib/apple';
import { videoIdFromUrl, siteFromUrl } from '../src/lib/media';
import { podcastUnavailableMessage, transcriptKeys } from '../src/lib/podcast';
import { decodeEntities, parseDuration } from '../src/lib/rss';
import { parseIsoDuration, pickSpotifyEpisode, spotifyEpisodeIdFromUrl } from '../src/lib/spotify';
import { isPodcastSite } from '../src/lib/types';
import { parseXimalayaRss, ximalayaSoundIdFromUrl } from '../src/lib/ximalaya';

describe('site routing', () => {
  it('recognises each supported site', () => {
    expect(siteFromUrl('https://www.youtube.com/watch?v=tBMlXQIrYK4')).toBe('youtube');
    expect(siteFromUrl('https://music.youtube.com/watch?v=tBMlXQIrYK4')).toBe('youtube');
    expect(siteFromUrl('https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd')).toBe('xiaoyuzhou');
    expect(siteFromUrl('https://podcasts.apple.com/cn/podcast/x/id1482731836?i=1000803684525')).toBe('apple');
    expect(siteFromUrl('https://www.ximalaya.com/sound/624968931')).toBe('ximalaya');
    expect(siteFromUrl('https://open.spotify.com/episode/0Zb3l5abcDEF1234567890')).toBe('spotify');
    expect(siteFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
  });

  it('maps episode URLs to extension ids', () => {
    expect(videoIdFromUrl('https://music.youtube.com/watch?v=tBMlXQIrYK4')).toBe('tBMlXQIrYK4');
    expect(videoIdFromUrl('https://podcasts.apple.com/cn/podcast/vol-362/id1482731836?i=1000803684525')).toBe(
      'pod:ap:1000803684525',
    );
    expect(videoIdFromUrl('https://podcasts.apple.com/cn/podcast/x/id1482731836')).toBeNull();
    expect(videoIdFromUrl('https://www.ximalaya.com/sound/624968931')).toBe('pod:xm:624968931');
    expect(videoIdFromUrl('https://www.ximalaya.com/album/56109512')).toBeNull();
    expect(videoIdFromUrl('https://open.spotify.com/episode/0Zb3l5abcDEF1234567890?si=abc')).toBe(
      'pod:sp:0Zb3l5abcDEF1234567890',
    );
    expect(videoIdFromUrl('https://open.spotify.com/show/0Zb3l5abcDEF1234567890')).toBeNull();
  });

  it('treats every podcast id prefix as a podcast', () => {
    for (const site of ['xiaoyuzhou', 'apple', 'ximalaya', 'spotify']) expect(isPodcastSite(site)).toBe(true);
    expect(isPodcastSite('youtube')).toBe(false);
    expect(isPodcastSite(undefined)).toBe(false);
  });
});

describe('Apple Podcasts', () => {
  it('reads show, episode and storefront from the URL', () => {
    expect(
      appleUrlInfo('https://podcasts.apple.com/cn/podcast/vol-362/id1482731836?i=1000803684525'),
    ).toEqual({ showId: '1482731836', episodeId: '1000803684525', country: 'cn' });
  });

  it('picks the matching episode from an iTunes lookup', () => {
    const results = [
      { wrapperType: 'collection', collectionName: '文化有限' },
      {
        wrapperType: 'podcastEpisode',
        trackId: 1000803684525,
        trackName: 'Vol.362 万历十五年',
        collectionName: '文化有限',
        trackTimeMillis: 8204000,
        episodeUrl: 'https://tk.example/a.m4a',
        episodeGuid: 'guid-1',
      },
    ];
    expect(pickAppleEpisode(results, '1000803684525')).toEqual({
      title: 'Vol.362 万历十五年',
      channel: '文化有限',
      duration: 8204,
      audioUrl: 'https://tk.example/a.m4a',
      guid: 'guid-1',
    });
    expect(pickAppleEpisode(results, '999')).toBeNull();
    expect(pickAppleEpisode(null, '1')).toBeNull();
  });
});

const XM_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[肥话连篇]]></title>
    <item>
      <title><![CDATA[上一期]]></title>
      <link>https://www.ximalaya.com/sound/111</link>
      <guid>xmly_track_111</guid>
      <enclosure url="https://a.example/1.m4a?x=1&amp;y=2" type="audio/m4a" length="10" />
      <itunes:duration>30:00</itunes:duration>
    </item>
    <item>
      <title><![CDATA[VOL.068：当播客也可以打赏]]></title>
      <link>https://www.ximalaya.com/sound/624968931</link>
      <guid>xmly_track_624968931</guid>
      <enclosure
          length="173972178"
          type="audio/x-m4a"
          url="https://jt.ximalaya.com//abc.m4a?channel=rss&amp;album_id=56109512&amp;track_id=624968931"
      />
      <itunes:duration>1:12:19</itunes:duration>
    </item>
  </channel>
</rss>`;

describe('Ximalaya', () => {
  it('parses only sound pages, not albums', () => {
    expect(ximalayaSoundIdFromUrl('https://www.ximalaya.com/sound/624968931')).toBe('624968931');
    expect(ximalayaSoundIdFromUrl('https://www.ximalaya.com/sound/624968931/')).toBe('624968931');
    expect(ximalayaSoundIdFromUrl('https://www.ximalaya.com/album/56109512')).toBeNull();
    expect(ximalayaSoundIdFromUrl('https://example.com/sound/1')).toBeNull();
  });

  it('finds the episode in the album feed and decodes the enclosure', () => {
    expect(parseXimalayaRss(XM_RSS, '624968931')).toEqual({
      title: 'VOL.068：当播客也可以打赏',
      channel: '肥话连篇',
      duration: 4339,
      audioUrl: 'https://jt.ximalaya.com//abc.m4a?channel=rss&album_id=56109512&track_id=624968931',
      guid: 'xmly_track_624968931',
    });
    expect(parseXimalayaRss(XM_RSS, '999')).toBeNull();
  });
});

describe('Spotify', () => {
  it('reads episode ids', () => {
    expect(spotifyEpisodeIdFromUrl('https://open.spotify.com/episode/0Zb3l5abcDEF1234567890')).toBe(
      '0Zb3l5abcDEF1234567890',
    );
    expect(spotifyEpisodeIdFromUrl('https://open.spotify.com/embed/episode/0Zb3l5abcDEF1234567890')).toBe(
      '0Zb3l5abcDEF1234567890',
    );
    expect(spotifyEpisodeIdFromUrl('https://open.spotify.com/show/0Zb3l5abcDEF1234567890')).toBeNull();
  });

  it('reads JSON-LD metadata and ISO durations', () => {
    expect(parseIsoDuration('PT1H12M19S')).toBe(4339);
    expect(parseIsoDuration('PT45M')).toBe(2700);
    expect(parseIsoDuration('not a duration')).toBe(0);
    expect(
      pickSpotifyEpisode({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'PodcastEpisode',
            name: '第 68 期',
            timeRequired: 'PT1H12M19S',
            partOfSeries: { '@type': 'PodcastSeries', name: '肥话连篇' },
          },
        ],
      }),
    ).toEqual({ title: '第 68 期', channel: '肥话连篇', duration: 4339 });
  });

  it('explains the DRM limitation instead of offering ASR', () => {
    expect(podcastUnavailableMessage('spotify')).toMatch(/DRM/);
  });
});

describe('RSS helpers', () => {
  it('parses common duration formats', () => {
    expect(parseDuration('4339')).toBe(4339);
    expect(parseDuration('12:19')).toBe(739);
    expect(parseDuration('1:12:19')).toBe(4339);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('abc')).toBe(0);
  });

  it('decodes entities without double-decoding escaped amp', () => {
    expect(decodeEntities('a&amp;b &#37; &#x41;')).toBe('a&b % A');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('shared keys', () => {
  it('matches the desktop app sha1(guid) / sha1(audio_url) keys', async () => {
    expect(
      await transcriptKeys(
        'xmly_track_624968931',
        'https://jt.ximalaya.com//abc.m4a?channel=rss&album_id=56109512',
      ),
    ).toEqual([
      'guid:9fa5a13e1ad97b7ad9264f41ca0940db6a054a52',
      'audio:c301147b7042737d710e3f354de171bd421a43c0',
    ]);
    expect(await transcriptKeys(undefined, null)).toEqual([]);
  });
});
