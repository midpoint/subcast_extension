import type {
  ChatTurn,
  DisplayMode,
  EpisodeSource,
  ExtensionSettings,
  LlmConfig,
  Segment,
  TabSnapshot,
  VideoMeta,
} from './types';

/** Panel → background over a long-lived port (`subcast-panel`). */
export type PanelRequest =
  | { type: 'PANEL_HELLO'; tabId?: number }
  | { type: 'RELOAD_STATE'; tabId?: number }
  | { type: 'LOAD'; videoId: string; force?: boolean }
  | { type: 'TRANSLATE'; videoId: string }
  | { type: 'CANCEL_TRANSLATE'; videoId: string }
  | { type: 'SEEK'; seconds: number }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'LOOKUP_GUIDE'; videoId: string }
  | { type: 'GENERATE_GUIDE'; videoId: string; force?: boolean }
  | { type: 'CHAT'; requestId: string; videoId: string; question: string; history: ChatTurn[] }
  | { type: 'CHAT_CANCEL'; requestId: string }
  | { type: 'RUN_ASR'; videoId: string }
  | { type: 'SET_DISPLAY'; displayMode: DisplayMode; overlay?: boolean; overlayMode?: DisplayMode };

/** Background → panel. */
export type PanelEvent =
  | { type: 'SNAPSHOT'; snapshot: TabSnapshot }
  | { type: 'TICK'; videoId: string; time: number; duration: number; paused: boolean }
  | { type: 'EPISODE_UPDATED'; videoId: string; revision: number }
  | { type: 'TRANSLATE_PROGRESS'; videoId: string; done: number; total: number }
  | { type: 'TOAST'; kind: 'info' | 'error'; message: string }
  | { type: 'GUIDE'; videoId: string; text: string; source: 'shared' | 'llm' | 'cache'; model?: string }
  | { type: 'GUIDE_ERROR'; videoId: string; message: string }
  | { type: 'GUIDE_NONE'; videoId: string }
  | { type: 'CHAT_DELTA'; requestId: string; text: string }
  | { type: 'CHAT_DONE'; requestId: string; text: string; model?: string }
  | { type: 'CHAT_ERROR'; requestId: string; message: string }
  | { type: 'ASR_PROGRESS'; videoId: string; stage: string; percent: number; message: string }
  | { type: 'ASR_DONE'; videoId: string }
  | { type: 'ASR_ERROR'; videoId: string; message: string };

export interface SubtitlesMessage {
  type: 'SUBTITLES';
  videoId: string;
  key: string;
  segments: Segment[];
  items: (string | null)[] | null;
  source: EpisodeSource;
  sharedSource?: string;
  language: string;
  mode: DisplayMode;
  overlay: boolean;
  overlayMode: DisplayMode;
}

/** Content script → background (one-shot). */
export type ContentRequest =
  | { type: 'YT_META'; meta: VideoMeta }
  | { type: 'OPEN_PANEL' }
  | { type: 'CONTENT_READY'; videoId: string | null; url: string };

/** Background → content script (tabs.sendMessage). */
export type ContentEvent =
  | SubtitlesMessage
  | { type: 'SEEK'; seconds: number }
  | { type: 'RESYNC' }
  | { type: 'SETTINGS'; displayMode: DisplayMode; overlay: boolean; overlayMode: DisplayMode }
  | { type: 'CLEAR' };

/** Background → offscreen document. */
export type OffscreenRequest =
  | {
      type: 'OFFSCREEN_TRANSLATE';
      videoId: string;
      engine: 'google' | 'llm';
      llm: LlmConfig;
      title: string;
      show: string;
    }
  | {
      type: 'OFFSCREEN_ASR';
      videoId: string;
      audioUrl: string;
      provider: 'groq' | 'openai';
      apiKey: string;
      model: string;
      language: string;
      meta: { title: string; channel: string; duration: number };
    }
  | { type: 'OFFSCREEN_CANCEL'; videoId: string };

/** Offscreen → background. */
export type OffscreenEvent =
  | { type: 'TR_PROGRESS'; videoId: string; items: (string | null)[]; done: number; total: number }
  | { type: 'TR_DONE'; videoId: string; translated: number; total: number }
  | { type: 'TR_ERROR'; videoId: string; message: string }
  | { type: 'TR_CANCELLED'; videoId: string }
  | { type: 'ASR_PROGRESS'; videoId: string; stage: string; percent: number; message: string }
  | { type: 'ASR_DONE'; videoId: string; language: string; model: string; segments: Segment[] }
  | { type: 'ASR_ERROR'; videoId: string; message: string }
  | { type: 'OFFSCREEN_READY' };

export interface SettingsSnapshot {
  settings: ExtensionSettings;
  appVersion: string;
}
