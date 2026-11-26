/** Shared data model. Mirrors the desktop app: segments are `{start,end,text}` and a translation's
 *  `items` is aligned 1:1 with them (`null` = not translated). Do not invent another shape. */

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Translation {
  lang: string;
  engine: 'google' | 'llm';
  model: string;
  items: (string | null)[];
  /** "partial" while batches are still arriving; cached across page reloads. */
  status: 'partial' | 'done';
  /** Set when the Chinese punctuation pass finished (absent = not tried yet). */
  punctuatedAt?: number;
  updatedAt: number;
}

export interface CaptionTrack {
  baseUrl: string;
  language: string;
  /** Auto-generated (YouTube ASR) rather than human-authored. */
  auto: boolean;
  name: string;
  vssId?: string;
}

export interface AudioFormat {
  url: string;
  mimeType: string;
  bitrate?: number;
  itag?: number;
  contentLength?: number;
  audioQuality?: string;
}

/** Everything the watch page (or InnerTube) tells us about the current video. Also used for a
 *  podcast episode page: `audioUrl` is the episode's media file and `tracks` is empty. */
export interface VideoMeta {
  videoId: string;
  title: string;
  channel: string;
  duration: number;
  url: string;
  tracks: CaptionTrack[];
  audio: AudioFormat[];
  /** Direct audio file for cloud ASR when the site is not YouTube (podcast episodes). */
  audioUrl?: string;
  site?: 'youtube' | 'xiaoyuzhou';
  originalLanguage?: string;
  channelId?: string;
  capturedAt: number;
  origin: 'page' | 'innertube';
}

export type EpisodeSource = 'official' | 'youtube-auto' | 'shared' | 'cloud';

export interface EpisodeRecord {
  /** `yt:<videoId>` */
  key: string;
  videoId: string;
  title: string;
  channel: string;
  duration: number;
  language: string;
  /** Audio-track language the player reported when this transcript was fetched (dedupes refetches). */
  spokenLanguage?: string;
  /** The user picked this caption track by hand, so automatic track correction must not replace it. */
  manualTrack?: boolean;
  source: EpisodeSource;
  /** The shared version's own source (`official`, `cloud`, `whisper`, `qwen3`) when source is `shared`. */
  sharedSource?: string;
  segments: Segment[];
  translation: Translation | null;
  /** Where a cloud transcript came from: model name, ASR provider. */
  asrModel?: string;
  /** Set when the Chinese transcript's own punctuation pass finished (absent = not tried yet). */
  punctuatedAt?: number;
  /** When a cloud transcript was successfully shared (avoids uploading twice). */
  uploadedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GuideRecord {
  /** `yt:<videoId>` */
  key: string;
  text: string;
  model: string;
  source: 'shared' | 'llm';
  createdAt: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export type DisplayMode = 'bilingual' | 'zh' | 'original';

export type JobStatus =
  | { state: 'idle' }
  | { state: 'loading'; step: string }
  | { state: 'ready' }
  | { state: 'no-captions' }
  | { state: 'translating'; done: number; total: number }
  | { state: 'error'; message: string };

/** What the side panel and content script need to know about the tab's current video. */
export interface TabSnapshot {
  tabId: number;
  url: string;
  videoId: string | null;
  meta: VideoMeta | null;
  time: number;
  duration: number;
  paused: boolean;
  status: JobStatus;
  /** Bumped whenever the episode or its translation changes in IndexedDB. */
  revision: number;
}

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ExtensionSettings {
  /** Google's free endpoint (with the relay fallback), or the user's own model. */
  translateEngine: 'google' | 'llm';
  llm: LlmConfig;
  autoTranslate: boolean;
  /** Fill in missing punctuation in the Chinese translation with the configured model. */
  autoPunctuate: boolean;
  useShared: boolean;
  shareTranscripts: boolean;
  displayMode: DisplayMode;
  overlay: boolean;
  overlayMode: DisplayMode;
  asrEngine: 'off' | 'groq' | 'openai';
  asrKey: string;
  asrModel: string;
  asrLanguage: string;
  /** Random UUID v4, sent only as the shared service's anonymous install id. */
  installId: string;
  /** One-time note that keys live in extension storage, not a system keychain. */
  acknowledgedKeyRisk?: boolean;
}

/** YouTube ids get the `yt:` prefix the shared service expects; podcast ids (`qm:<eid>`) already
 *  carry the desktop app's key and pass through unchanged. */
const KEY_PREFIX = /^(?:yt|qm|guid|audio|pod):/;

export const EPISODE_KEY = (videoId: string) => (KEY_PREFIX.test(videoId) ? videoId : `yt:${videoId}`);

export function isDisplayMode(x: unknown): x is DisplayMode {
  return x === 'bilingual' || x === 'zh' || x === 'original';
}
