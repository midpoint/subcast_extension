import type { DisplayMode, ExtensionSettings } from './types';

const KEY = 'subcast.settings.v1';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  translateEngine: 'google',
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  },
  autoTranslate: true,
  useShared: true,
  shareTranscripts: true,
  displayMode: 'bilingual',
  overlay: true,
  overlayMode: 'bilingual',
  asrEngine: 'off',
  asrKey: '',
  asrModel: '',
  asrLanguage: 'auto',
  installId: '',
};

function normalize(raw: unknown): ExtensionSettings {
  const r = (raw ?? {}) as Partial<ExtensionSettings>;
  const llm = { ...DEFAULT_SETTINGS.llm, ...(r.llm ?? {}) };
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    llm,
    displayMode: mode(r.displayMode, DEFAULT_SETTINGS.displayMode),
    overlayMode: mode(r.overlayMode, DEFAULT_SETTINGS.overlayMode),
    asrEngine: r.asrEngine === 'groq' || r.asrEngine === 'openai' ? r.asrEngine : 'off',
    asrLanguage: typeof r.asrLanguage === 'string' && r.asrLanguage ? r.asrLanguage : 'auto',
  };
}

const mode = (x: unknown, fallback: DisplayMode): DisplayMode =>
  x === 'bilingual' || x === 'zh' || x === 'original' ? x : fallback;

/** Generated once per install; the shared service asks for a stable anonymous id. */
export function newInstallId(): string {
  return crypto.randomUUID();
}

export async function getSettings(): Promise<ExtensionSettings> {
  const got = await chrome.storage.local.get(KEY);
  const s = normalize(got[KEY]);
  if (!s.installId) {
    s.installId = newInstallId();
    await chrome.storage.local.set({ [KEY]: s });
  }
  return s;
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const cur = await getSettings();
  const next = normalize({ ...cur, ...patch, llm: { ...cur.llm, ...(patch.llm ?? {}) } });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Fires with the merged settings whenever anything changes (options page, another tab). */
export function onSettingsChanged(cb: (s: ExtensionSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(normalize(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** DeepSeek is the preset the project recommends: direct, cheap, one key for translation and Q&A. */
export const LLM_PRESETS: { id: string; name: string; baseUrl: string; model: string; keyUrl: string }[] = [
  { id: 'deepseek', name: 'DeepSeek（推荐）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', keyUrl: 'https://ollama.com' },
];

export const ASR_PRESETS: Record<'groq' | 'openai', { name: string; baseUrl: string; model: string; keyUrl: string }> = {
  groq: { name: 'Groq Whisper', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', keyUrl: 'https://console.groq.com/keys' },
  openai: { name: 'OpenAI Whisper', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
};
