/** Cross-site podcast plumbing: resolving the audio URL a page does not expose, and the extra
 *  shared-library keys the desktop app uses for podcast episodes. */
import { appleUrlInfo, fetchAppleEpisode } from './apple';
import type { PodcastEpisode, VideoMeta } from './types';
import { fetchXimalayaEpisode, ximalayaSoundIdFromUrl } from './ximalaya';

export const SPOTIFY_DRM_NOTICE =
  'Spotify 的音频使用 DRM 加密，扩展无法下载，也就无法生成字幕或翻译。如果同一档节目也在 Apple Podcasts、小宇宙或喜马拉雅更新，可以在那里打开单集。';

export function mediaUnavailableMessage(site?: string): string {
  switch (site) {
    case 'xiaoyuzhou':
      return '这是付费或私有单集，拿不到公开音频，无法生成字幕。';
    case 'apple':
      return '没有拿到这期节目的音频地址。Apple Podcasts 只公开一档节目最近 200 集的信息，较早的单集可能不在其中；也可能是网络请求失败，可以稍后重试。';
    case 'ximalaya':
      return '没有拿到这期的公开音频。可能是付费或私密专辑，或者这期节目不在喜马拉雅的公开 RSS 列表里。';
    case 'spotify':
      return SPOTIFY_DRM_NOTICE;
    case 'x':
      return '没有拿到这条帖子的视频文件。可能是受保护账号、付费内容、直播，或这条帖子只有 HLS 视频流；也可能是这条帖子不含视频。';
    default:
      return '没有拿到这期的公开音频，无法生成字幕。';
  }
}

export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The same keys `crates/subcast-core/src/shared.rs` computes for an RSS episode, so a transcript
 *  shared by the desktop app is found here and the other way round. */
export async function transcriptKeys(guid?: string | null, audioUrl?: string | null): Promise<string[]> {
  const keys: string[] = [];
  if (guid) keys.push(`guid:${await sha1Hex(guid)}`);
  if (audioUrl) keys.push(`audio:${await sha1Hex(audioUrl)}`);
  return keys;
}

/** Reads an Apple or Ximalaya episode's full details (the page alone has no audio URL). Returns null
 *  when the site is not resolved this way or the catalogue does not list the episode. */
export async function resolvePodcastEpisode(
  meta: VideoMeta,
): Promise<{ episode: PodcastEpisode; sharedKeys: string[] } | null> {
  if (meta.site === 'apple') {
    const info = appleUrlInfo(meta.url);
    if (!info?.episodeId) return null;
    const episode = await fetchAppleEpisode(info.showId, info.episodeId, info.country);
    if (!episode) return null;
    return { episode, sharedKeys: await transcriptKeys(episode.guid, episode.audioUrl) };
  }
  if (meta.site === 'ximalaya') {
    const soundId = ximalayaSoundIdFromUrl(meta.url) ?? meta.videoId.match(/^pod:xm:(\d+)$/)?.[1];
    if (!soundId || !meta.albumId) return null;
    const episode = await fetchXimalayaEpisode(meta.albumId, soundId);
    if (!episode) return null;
    return { episode, sharedKeys: await transcriptKeys(episode.guid, episode.audioUrl) };
  }
  return null;
}
