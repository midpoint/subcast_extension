import { describe, expect, it } from 'vitest';
import { videoIdFromUrl } from '../src/lib/media';
import { EPISODE_KEY } from '../src/lib/types';
import { episodeFromNextData, episodeIdFromUrl, episodeMetaFromHtml, nextDataFromHtml } from '../src/lib/xiaoyuzhou';

const episode = {
  eid: '688cc1cc8e06fe8de7d920cd',
  title: '关于 AI Infra 的一切 | 对谈阶跃星辰联创朱亦博',
  duration: 3488,
  payType: 'FREE',
  isPrivateMedia: false,
  media: {
    id: '648b0b641c48983391a63f98/lkhmOdOOesDEETSXGFQV4cuVFSGe.m4a',
    mimeType: 'audio/mp4',
    source: { mode: 'PUBLIC', url: 'https://media.xyzcdn.net/648b0b641c48983391a63f98/lkhmOdOOesDEETSXGFQV4cuVFSGe.m4a' },
  },
  podcast: { pid: '648b0b641c48983391a63f98', title: '42章经', author: 'KaiQu' },
};

const page = (ep: unknown) =>
  `<html><head><title>关于 AI Infra 的一切 | 小宇宙</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { episode: ep } } })}</script></body></html>`;

describe('Xiaoyuzhou episode urls', () => {
  it('recognizes episode pages and derives the desktop key', () => {
    expect(episodeIdFromUrl('https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd')).toBe('688cc1cc8e06fe8de7d920cd');
    expect(episodeIdFromUrl('https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd?utm_source=x')).toBe('688cc1cc8e06fe8de7d920cd');
    expect(episodeIdFromUrl('https://www.xiaoyuzhoufm.com/podcast/648b0b641c48983391a63f98')).toBeNull();
    expect(episodeIdFromUrl('https://example.com/episode/688cc1cc8e06fe8de7d920cd')).toBeNull();
    expect(videoIdFromUrl('https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd')).toBe('qm:688cc1cc8e06fe8de7d920cd');
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=tBMlXQIrYK4')).toBe('tBMlXQIrYK4');
    expect(videoIdFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
    expect(EPISODE_KEY('qm:688cc1cc8e06fe8de7d920cd')).toBe('qm:688cc1cc8e06fe8de7d920cd');
    expect(EPISODE_KEY('tBMlXQIrYK4')).toBe('yt:tBMlXQIrYK4');
  });
});

describe('Xiaoyuzhou episode page', () => {
  it('reads title, show, duration and the public audio file', () => {
    const html = page(episode);
    expect(nextDataFromHtml(html)).not.toBeNull();
    const meta = episodeMetaFromHtml(html, 'https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd');
    expect(meta).not.toBeNull();
    expect(meta!.videoId).toBe('qm:688cc1cc8e06fe8de7d920cd');
    expect(meta!.title).toBe('关于 AI Infra 的一切 | 对谈阶跃星辰联创朱亦博');
    expect(meta!.channel).toBe('42章经');
    expect(meta!.duration).toBe(3488);
    expect(meta!.site).toBe('xiaoyuzhou');
    expect(meta!.tracks).toEqual([]);
    expect(meta!.audioUrl).toBe('https://media.xyzcdn.net/648b0b641c48983391a63f98/lkhmOdOOesDEETSXGFQV4cuVFSGe.m4a');
  });

  it('does not offer cloud ASR a paid or private episode', () => {
    const paid = episodeFromNextData({ props: { pageProps: { episode: { ...episode, payType: 'PAID' } } } });
    expect(paid?.paid).toBe(true);
    expect(paid?.audioUrl).toBeUndefined();
    const privateMode = episodeFromNextData({
      props: { pageProps: { episode: { ...episode, media: { source: { mode: 'PRIVATE', url: episode.media.source.url } } } } },
    });
    expect(privateMode?.audioUrl).toBeUndefined();
  });

  it('accepts the enclosure url and rejects unrelated pages', () => {
    const legacy = { ...episode, media: undefined, enclosure: { url: 'https://example.com/ep.mp3' } };
    expect(episodeFromNextData({ props: { pageProps: { episode: legacy } } })?.audioUrl).toBe('https://example.com/ep.mp3');
    expect(episodeMetaFromHtml('<html><body>no next data</body></html>', 'https://www.xiaoyuzhoufm.com/episode/688cc1cc8e06fe8de7d920cd')).toBeNull();
    expect(episodeFromNextData({ props: { pageProps: {} } })).toBeNull();
  });
});
