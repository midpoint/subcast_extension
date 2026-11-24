import {
  AlertTriangle,
  ArrowDown,
  CloudDownload,
  Languages,
  Loader2,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clock } from '../../src/lib/captions';
import { getChat, getEpisode, getGuide, putChat } from '../../src/lib/db';
import { llmReady } from '../../src/lib/llm';
import type { PanelEvent, PanelRequest } from '../../src/lib/messages';
import { getSettings, onSettingsChanged } from '../../src/lib/settings';
import type { ChatTurn, ExtensionSettings, TabSnapshot } from '../../src/lib/types';
import { EPISODE_KEY } from '../../src/lib/types';
import { needsTranslation, shouldTranslate } from '../../src/lib/translate';
import ChatView from './ChatView';
import GuideView from './GuideView';
import SubtitleList from './SubtitleList';

type Tab = 'subs' | 'guide' | 'chat';
type GuideState = { text: string; source: 'shared' | 'llm' | 'cache'; model?: string } | null;

const SOURCE_LABEL: Record<string, string> = {
  official: '官方字幕',
  'youtube-auto': 'YouTube 自动字幕',
  shared: '共享字幕',
  cloud: '云端识别',
};

const SHARED_LABEL: Record<string, string> = {
  official: '官方',
  cloud: '云端',
  whisper: '本地识别',
  qwen3: '本地识别',
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [snapshot, setSnapshot] = useState<TabSnapshot | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [episode, setEpisode] = useState<Awaited<ReturnType<typeof getEpisode>>>(null);
  const [tab, setTab] = useState<Tab>('subs');
  const [time, setTime] = useState(0);
  const [follow, setFollow] = useState(true);
  const [toast, setToast] = useState<{ kind: 'info' | 'error'; message: string } | null>(null);
  const [guide, setGuide] = useState<GuideState>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState('');
  const [guideChecked, setGuideChecked] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  const [chatError, setChatError] = useState('');
  const [confirmAsr, setConfirmAsr] = useState(false);
  const debugTabId = useMemo(() => {
    const n = Number(new URLSearchParams(location.search).get('tabId'));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, []);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const handlerRef = useRef<(msg: PanelEvent) => void>(() => {});
  const snapshotRef = useRef<TabSnapshot | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatTurn[]>([]);
  const pendingRef = useRef<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVideo = useRef<string | null>(null);

  const videoId = snapshot?.videoId ?? null;
  const mode = settings?.displayMode ?? 'bilingual';
  const llmConfigured = Boolean(settings && llmReady(settings.llm));
  const asrConfigured = Boolean(settings && settings.asrEngine !== 'off' && settings.asrKey.trim());

  /* ---------------------------------------------------------------- port + settings */
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (closed) return;
      try {
        const p = chrome.runtime.connect({ name: 'subcast-panel' });
        portRef.current = p;
        p.onMessage.addListener((msg: PanelEvent) => handlerRef.current(msg));
        p.onDisconnect.addListener(() => {
          portRef.current = null;
          timer = setTimeout(open, 1200);
        });
        p.postMessage({ type: 'PANEL_HELLO', tabId: debugTabId } satisfies PanelRequest);
      } catch {
        timer = setTimeout(open, 1500);
      }
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      portRef.current?.disconnect();
    };
  }, [debugTabId]);

  useEffect(() => {
    void getSettings().then(setSettings);
    return onSettingsChanged(setSettings);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const post = useCallback((msg: PanelRequest) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      /* port reconnecting */
    }
  }, []);

  const reloadEpisode = useCallback((vid: string, delay = 0) => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void getEpisode(EPISODE_KEY(vid)).then((rec) => {
        if (videoIdRef.current === vid) setEpisode(rec);
      });
    }, delay);
  }, []);

  /* ---------------------------------------------------------------- video changes */
  useEffect(() => {
    if (videoId === prevVideo.current) return;
    prevVideo.current = videoId;
    videoIdRef.current = videoId;
    setEpisode(null);
    setGuide(null);
    setGuideChecked(false);
    setGuideError('');
    setGuideLoading(false);
    setMessages([]);
    messagesRef.current = [];
    setPendingChat(null);
    pendingRef.current = null;
    setChatError('');
    setConfirmAsr(false);
    setTime(snapshotRef.current?.time ?? 0);
    setFollow(true);
    if (!videoId) return;
    let alive = true;
    void (async () => {
      const [rec, turns, g] = await Promise.all([getEpisode(EPISODE_KEY(videoId)), getChat(EPISODE_KEY(videoId)), getGuide(EPISODE_KEY(videoId))]);
      if (!alive || videoIdRef.current !== videoId) return;
      setEpisode(rec);
      setMessages(turns);
      messagesRef.current = turns;
      if (g) {
        setGuide({ text: g.text, source: g.source === 'shared' ? 'shared' : 'cache', model: g.model });
        setGuideChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
    // snapshot is read through the ref on purpose: it changes on every tick.
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- panel events */
  const eventHandler = useCallback(
    (msg: PanelEvent) => {
      switch (msg.type) {
        case 'SNAPSHOT': {
          const prev = snapshotRef.current;
          if (!prev || prev.videoId !== msg.snapshot.videoId) setTime(msg.snapshot.time);
          snapshotRef.current = msg.snapshot;
          setSnapshot(msg.snapshot);
          break;
        }
        case 'TICK':
          if (msg.videoId === videoIdRef.current) {
            setTime(msg.time);
            setSnapshot((s) => (s && s.videoId === msg.videoId ? { ...s, time: msg.time, duration: msg.duration, paused: msg.paused } : s));
          }
          break;
        case 'EPISODE_UPDATED':
          if (msg.videoId === videoIdRef.current) reloadEpisode(msg.videoId);
          break;
        case 'TRANSLATE_PROGRESS':
          if (msg.videoId === videoIdRef.current) {
            setSnapshot((s) => (s && s.videoId === msg.videoId ? { ...s, status: { state: 'translating', done: msg.done, total: msg.total } } : s));
            reloadEpisode(msg.videoId, 600);
          }
          break;
        case 'TOAST':
          setToast({ kind: msg.kind, message: msg.message });
          break;
        case 'GUIDE':
          if (msg.videoId === videoIdRef.current) {
            setGuide({ text: msg.text, source: msg.source, model: msg.model });
            setGuideError('');
            setGuideLoading(false);
            setGuideChecked(true);
          }
          break;
        case 'GUIDE_NONE':
          if (msg.videoId === videoIdRef.current) {
            setGuideLoading(false);
            setGuideChecked(true);
          }
          break;
        case 'GUIDE_ERROR':
          if (msg.videoId === videoIdRef.current) {
            setGuideError(msg.message);
            setGuideLoading(false);
            setGuideChecked(true);
          }
          break;
        case 'CHAT_DELTA':
          if (msg.requestId === pendingRef.current) {
            const next = [...messagesRef.current];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
              messagesRef.current = next;
              setMessages(next);
            }
          }
          break;
        case 'CHAT_DONE':
          if (msg.requestId === pendingRef.current) {
            const next = [...messagesRef.current];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, content: msg.text || last.content, model: msg.model };
              messagesRef.current = next;
              setMessages(next);
              const vid = videoIdRef.current;
              if (vid) void putChat(EPISODE_KEY(vid), next);
            }
            pendingRef.current = null;
            setPendingChat(null);
          }
          break;
        case 'CHAT_ERROR':
          if (msg.requestId === pendingRef.current) {
            const next = [...messagesRef.current];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && !last.content.trim()) next.pop();
            messagesRef.current = next;
            setMessages(next);
            setChatError(msg.message);
            pendingRef.current = null;
            setPendingChat(null);
            const vid = videoIdRef.current;
            if (vid) void putChat(EPISODE_KEY(vid), next);
          }
          break;
        case 'ASR_PROGRESS':
          if (msg.videoId === videoIdRef.current) {
            setSnapshot((s) => (s && s.videoId === msg.videoId ? { ...s, status: { state: 'loading', step: msg.message } } : s));
          }
          break;
        case 'ASR_DONE':
          if (msg.videoId === videoIdRef.current) {
            setConfirmAsr(false);
            reloadEpisode(msg.videoId, 300);
            setToast({ kind: 'info', message: '云端识别完成' });
          }
          break;
        case 'ASR_ERROR':
          if (msg.videoId === videoIdRef.current) {
            setConfirmAsr(false);
            setToast({ kind: 'error', message: msg.message });
            reloadEpisode(msg.videoId, 300);
          }
          break;
      }
    },
    [reloadEpisode],
  );
  handlerRef.current = eventHandler;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') post({ type: 'RELOAD_STATE', tabId: debugTabId });
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [post]);

  /* ---------------------------------------------------------------- guide lookup when the tab opens */
  useEffect(() => {
    if (tab !== 'guide' || !videoId || guide || guideChecked || guideLoading) return;
    setGuideLoading(true);
    post({ type: 'LOOKUP_GUIDE', videoId });
  }, [tab, videoId, guide, guideChecked, guideLoading, post]);

  /* ---------------------------------------------------------------- actions */
  const seek = useCallback(
    (seconds: number) => {
      setTime(seconds);
      setFollow(true);
      post({ type: 'SEEK', seconds });
    },
    [post],
  );

  const setDisplay = useCallback(
    (next: 'bilingual' | 'zh' | 'original') => {
      setSettings((s) => (s ? { ...s, displayMode: next, overlayMode: next } : s));
      post({ type: 'SET_DISPLAY', displayMode: next, overlayMode: next });
    },
    [post],
  );

  const toggleOverlay = useCallback(() => {
    if (!settings) return;
    const overlay = !settings.overlay;
    setSettings({ ...settings, overlay });
    post({ type: 'SET_DISPLAY', displayMode: settings.displayMode, overlay });
  }, [settings, post]);

  const translate = useCallback(() => {
    if (!videoId) return;
    post({ type: 'TRANSLATE', videoId });
  }, [videoId, post]);

  const retryLoad = useCallback(() => {
    if (!videoId) return;
    post({ type: 'LOAD', videoId, force: true });
  }, [videoId, post]);

  const ask = useCallback(
    (question: string, history: ChatTurn[]) => {
      const vid = videoIdRef.current;
      if (!vid || pendingRef.current) return;
      const requestId = crypto.randomUUID();
      const next = [...history, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: '' }];
      messagesRef.current = next;
      setMessages(next);
      pendingRef.current = requestId;
      setPendingChat(requestId);
      setChatError('');
      void putChat(EPISODE_KEY(vid), next.filter((m) => m.content.trim()));
      post({ type: 'CHAT', requestId, videoId: vid, question, history });
    },
    [post],
  );

  const send = useCallback((question: string) => ask(question, messagesRef.current.filter((m) => m.content.trim())), [ask]);

  const retryAnswer = useCallback(
    (assistantIndex: number) => {
      const msgs = messagesRef.current;
      const user = msgs[assistantIndex - 1];
      if (user?.role !== 'user') return;
      const history = msgs.slice(0, assistantIndex - 1).filter((m) => m.content.trim());
      messagesRef.current = history;
      setMessages(history);
      ask(user.content, history);
    },
    [ask],
  );

  const cancelChat = useCallback(() => {
    if (pendingRef.current) post({ type: 'CHAT_CANCEL', requestId: pendingRef.current });
  }, [post]);

  const newChat = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    setChatError('');
    const vid = videoIdRef.current;
    if (vid) void putChat(EPISODE_KEY(vid), []);
  }, []);

  const generateGuide = useCallback(
    (force: boolean) => {
      if (!videoId) return;
      setGuideLoading(true);
      setGuideError('');
      post({ type: 'GENERATE_GUIDE', videoId, force });
    },
    [videoId, post],
  );

  const openOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage();
  }, []);

  const runAsr = useCallback(() => {
    if (!videoId) return;
    post({ type: 'RUN_ASR', videoId });
  }, [videoId, post]);

  /* ---------------------------------------------------------------- derived view data */
  const status = snapshot?.status ?? { state: 'idle' as const };
  const translating = status.state === 'translating';
  const items = episode?.translation?.items ?? null;
  const incomplete = episode ? needsTranslation(items ?? [], episode.segments) : false;
  const isChinese = episode ? !shouldTranslate(episode.language) : false;
  const sourceLabel = episode
    ? episode.source === 'shared'
      ? `共享字幕${episode.sharedSource ? ` · ${SHARED_LABEL[episode.sharedSource] ?? episode.sharedSource}` : ''}`
      : SOURCE_LABEL[episode.source] ?? episode.source
    : '';
  const title = snapshot?.meta?.title || episode?.title || '';
  const channel = snapshot?.meta?.channel || episode?.channel || '';
  const duration = snapshot?.meta?.duration || episode?.duration || 0;

  const tabCount = useMemo(() => episode?.segments.length ?? 0, [episode]);

  /* ---------------------------------------------------------------- render */
  if (!videoId) {
    return (
      <div className="app">
        <Header title="" channel="" onSettings={openOptions} />
        <div className="empty">
          <div className="empty-mark">声</div>
          <p className="state-title">在 YouTube 打开一个视频</p>
          <p className="state-sub">SubCast 会在侧边栏显示双语字幕、AI 导读和问答。点工具栏上的图标可以随时打开或收起。</p>
          <button className="btn btn-ghost" type="button" onClick={openOptions}>
            <Settings size={14} /> 设置
          </button>
        </div>
      </div>
    );
  }

  const showList = Boolean(episode?.segments.length);
  const showLoading = !showList && (status.state === 'loading' || status.state === 'idle');
  const showNoCaptions = !showList && status.state === 'no-captions';
  const showError = !showList && status.state === 'error';

  return (
    <div className="app">
      <Header title={title} channel={channel} onSettings={openOptions} />

      <nav className="tabs">
        <button className={tab === 'subs' ? 'on' : ''} type="button" onClick={() => setTab('subs')}>
          字幕 {tabCount > 0 && <span className="count">{tabCount}</span>}
        </button>
        <button className={tab === 'guide' ? 'on' : ''} type="button" onClick={() => setTab('guide')}>
          导读
        </button>
        <button className={tab === 'chat' ? 'on' : ''} type="button" onClick={() => setTab('chat')}>
          问答
        </button>
      </nav>

      {tab === 'subs' && (
        <>
          <div className="sub-toolbar">
            <div className="segmented" role="group" aria-label="字幕显示">
              <button type="button" className={mode === 'bilingual' ? 'on' : ''} onClick={() => setDisplay('bilingual')} disabled={!episode}>
                双语
              </button>
              <button type="button" className={mode === 'zh' ? 'on' : ''} onClick={() => setDisplay('zh')} disabled={!episode}>
                中文
              </button>
              <button type="button" className={mode === 'original' ? 'on' : ''} onClick={() => setDisplay('original')} disabled={!episode}>
                原文
              </button>
            </div>
            <div className="sub-tools">
              <button className={`icon-btn ${settings?.overlay ? 'lit' : ''}`} type="button" title="在视频上显示字幕" onClick={toggleOverlay}>
                <Languages size={15} />
              </button>
              <button className={`icon-btn ${follow ? 'lit' : ''}`} type="button" title={follow ? '正在跟随播放' : '跟随播放'} onClick={() => setFollow((f) => !f)}>
                <ArrowDown size={15} />
              </button>
            </div>
          </div>

          {episode && (
            <div className="meta-row">
              <span className={`badge ${episode.source === 'shared' ? 'badge-shared' : ''}`}>{sourceLabel}</span>
              <span className="badge muted-badge">{episode.language.toUpperCase()}</span>
              {duration > 0 && <span className="muted small">{clock(duration)}</span>}
              <span className="grow" />
              {translating ? (
                <span className="trans-state">
                  <Loader2 size={12} className="spin" /> {status.state === 'translating' ? `${status.done}/${status.total}` : '翻译中'}
                </span>
              ) : isChinese ? (
                <span className="muted small">中文视频</span>
              ) : incomplete && episode.segments.length ? (
                <button className="btn btn-mini" type="button" onClick={translate}>
                  {episode.translation ? '继续翻译' : '翻译成中文'}
                </button>
              ) : episode.translation ? (
                <span className="muted small">{episode.translation.engine === 'llm' ? episode.translation.model || 'AI 翻译' : '谷歌翻译'}</span>
              ) : null}
            </div>
          )}

          {translating && status.state === 'translating' && (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${status.total ? Math.round((status.done / status.total) * 100) : 0}%` }} />
            </div>
          )}

          {showLoading && <Skeleton step={status.state === 'loading' ? status.step : '准备字幕'} />}

          {showNoCaptions && (
            <NoCaptions
              asrConfigured={asrConfigured}
              confirming={confirmAsr}
              onConfirm={() => setConfirmAsr(true)}
              onCancel={() => setConfirmAsr(false)}
              onRun={runAsr}
              onSettings={openOptions}
            />
          )}

          {showError && (
            <div className="state">
              <AlertTriangle size={24} className="warn" />
              <p className="state-title">字幕加载失败</p>
              <p className="state-sub">{status.state === 'error' ? status.message : ''}</p>
              <div className="state-actions">
                <button className="btn btn-ghost" type="button" onClick={retryLoad}>
                  <RefreshCw size={14} /> 重试
                </button>
                <button className="btn btn-ghost" type="button" onClick={openOptions}>
                  <Settings size={14} /> 设置
                </button>
              </div>
            </div>
          )}

          {showList && episode && (
            <SubtitleList
              segments={episode.segments}
              items={items}
              mode={mode}
              time={time}
              follow={follow}
              translating={translating}
              onSeek={seek}
              onFollowChange={setFollow}
            />
          )}
        </>
      )}

      {tab === 'guide' && (
        <GuideView
          text={guide?.text ?? null}
          loading={guideLoading}
          error={guideError}
          source={guide?.source}
          llmConfigured={llmConfigured}
          onGenerate={generateGuide}
          onOpenSettings={openOptions}
          onSeek={seek}
        />
      )}

      {tab === 'chat' && (
        <ChatView
          messages={messages}
          pending={Boolean(pendingChat)}
          error={chatError}
          llmConfigured={llmConfigured}
          onSend={send}
          onCancel={cancelChat}
          onRetry={retryAnswer}
          onNew={newChat}
          onSeek={seek}
          onOpenSettings={openOptions}
        />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.message}</span>
          <button className="icon-btn" type="button" onClick={() => setToast(null)}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function Header({ title, channel, onSettings }: { title: string; channel: string; onSettings: () => void }) {
  return (
    <header className="head">
      <div className="brand-row">
        <div className="brand">
          <span className="logo">声</span>
          <div>
            <div className="brand-name">SubCast</div>
            <div className="brand-sub">声渡 · 双语字幕</div>
          </div>
        </div>
        <button className="icon-btn" type="button" title="设置" onClick={onSettings}>
          <Settings size={16} />
        </button>
      </div>
      {title && (
        <div className="video-head">
          <div className="video-title" title={title}>
            {title}
          </div>
          {channel && <div className="video-channel">{channel}</div>}
        </div>
      )}
    </header>
  );
}

function Skeleton({ step }: { step: string }) {
  return (
    <div className="skeleton-wrap">
      <div className="skeleton-status">
        <Loader2 size={13} className="spin" /> {step}
      </div>
      {Array.from({ length: 9 }).map((_, i) => (
        <div className="skeleton-row" key={i} style={{ width: `${88 - (i % 3) * 9}%` }} />
      ))}
    </div>
  );
}

function NoCaptions({
  asrConfigured,
  confirming,
  onConfirm,
  onCancel,
  onRun,
  onSettings,
}: {
  asrConfigured: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRun: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="state">
      <CloudDownload size={26} className="accent" />
      <p className="state-title">该视频没有官方字幕</p>
      <p className="state-sub">
        YouTube 没有为这个视频提供字幕轨，共享字幕库里也还没有。可以用你自己的 Groq 或 OpenAI Key 做云端识别，识别完会自动翻译；音频只会发给你配置的服务。
      </p>
      {confirming ? (
        <div className="confirm-box">
          <p>会把整段音频发给你配置的识别服务，可能产生费用。继续？</p>
          <div className="state-actions">
            <button className="btn btn-primary" type="button" onClick={onRun}>
              开始识别
            </button>
            <button className="btn btn-ghost" type="button" onClick={onCancel}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="state-actions">
          {asrConfigured ? (
            <button className="btn btn-primary" type="button" onClick={onConfirm}>
              <CloudDownload size={14} /> 用云端识别
            </button>
          ) : null}
          <button className="btn btn-ghost" type="button" onClick={onSettings}>
            <Settings size={14} /> {asrConfigured ? '识别设置' : '配置云端识别'}
          </button>
        </div>
      )}
    </div>
  );
}
