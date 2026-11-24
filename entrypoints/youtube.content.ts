/** Isolated-world content script: reads the player response forwarded by youtube-main, follows the
 *  current video through YouTube's SPA navigation, streams playback time to the background, and
 *  paints the bilingual overlay on the player. All network calls happen in the background. */
import { activeIndex } from '../src/lib/captions';
import type { ContentEvent, SubtitlesMessage } from '../src/lib/messages';
import type { DisplayMode, VideoMeta } from '../src/lib/types';
import { metaFromPlayerResponse } from '../src/lib/youtube';

const SOURCE = 'subcast-page';

function currentVideoId(): string | null {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main() {
  let port: chrome.runtime.Port | null = null;
  let lastMeta: VideoMeta | null = null;
  const pendingMeta = new Map<string, { meta: VideoMeta; at: number }>();
  let payload: SubtitlesMessage | null = null;
  let overlayEnabled = true;
  let overlayMode: DisplayMode = 'bilingual';
  let lastRendered = '';
  let lastVideoId: string | null = currentVideoId();

  const videoEl = (): HTMLVideoElement | null =>
    (document.querySelector('#movie_player video.html5-main-video') as HTMLVideoElement | null) ??
    (document.querySelector('video.html5-main-video') as HTMLVideoElement | null) ??
    (document.querySelector('video') as HTMLVideoElement | null);

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'subcast-content' });
    } catch {
      port = null;
      setTimeout(connect, 1500);
      return;
    }
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1200);
    });
    if (lastMeta) port.postMessage({ type: 'META', meta: lastMeta });
    sendState();
  }

  function sendState() {
    const v = videoEl();
    if (!v || !port) return;
    try {
      port.postMessage({
        type: 'STATE',
        videoId: currentVideoId(),
        time: v.currentTime || 0,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
      });
    } catch {
      /* port closing */
    }
  }

  function sendMeta(meta: VideoMeta) {
    lastMeta = meta;
    try {
      port?.postMessage({ type: 'META', meta });
    } catch {
      /* reconnect will resend */
    }
  }

  function useMeta(meta: VideoMeta) {
    if (meta.videoId === currentVideoId()) {
      sendMeta({ ...meta, url: location.href });
    } else {
      pendingMeta.set(meta.videoId, { meta, at: Date.now() });
      for (const [id, v] of pendingMeta) if (Date.now() - v.at > 300_000) pendingMeta.delete(id);
    }
  }

  function onPageMessage(e: MessageEvent) {
    if (e.source !== window) return;
    const data = e.data as { source?: string; type?: string; videoId?: string; playerResponse?: any } | null;
    if (data?.source !== SOURCE) return;
    if (data.type === 'PLAYER' && data.playerResponse) {
      const meta = metaFromPlayerResponse(data.playerResponse, data.videoId ?? data.playerResponse?.videoDetails?.videoId ?? '', location.href, 'page');
      if (meta) useMeta(meta);
      return;
    }
    if (data.type === 'NAV') {
      const id = data.videoId ?? null;
      if (id !== lastVideoId) {
        lastVideoId = id;
        payload = null;
        lastRendered = '';
        removeOverlay();
        try {
          void chrome.runtime.sendMessage({ type: 'CONTENT_READY', videoId: id, url: location.href });
        } catch {
          /* worker restarting */
        }
      }
      if (id) {
        const pending = pendingMeta.get(id);
        if (pending) sendMeta({ ...pending.meta, url: location.href });
        window.postMessage({ source: 'subcast-content', type: 'RESYNC' }, '*');
      }
    }
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Overlay                                                                                          */
  /* ------------------------------------------------------------------------------------------------ */

  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;

  const OVERLAY_CSS = `
    :host { all: initial; }
    .wrap {
      position: absolute; left: 0; right: 0; bottom: clamp(58px, 9vh, 118px);
      display: flex; justify-content: center; pointer-events: none; padding: 0 3%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      transition: opacity .15s ease;
    }
    .box {
      max-width: min(94%, 1100px); background: rgba(12, 12, 14, .74); color: #fff;
      border-radius: 10px; padding: 8px 16px; text-align: center;
      box-shadow: 0 2px 14px rgba(0,0,0,.35); text-shadow: 0 1px 2px rgba(0,0,0,.7);
      backdrop-filter: blur(3px);
    }
    .orig { font-size: 19px; line-height: 1.42; opacity: .93; }
    .zh { font-size: 21px; line-height: 1.45; font-weight: 600; margin-top: 3px; }
    .zh:empty, .orig:empty { display: none; }
    .open {
      position: absolute; top: 10px; right: 10px; pointer-events: auto; cursor: pointer;
      border: 0; border-radius: 999px; padding: 5px 10px; font-size: 12px; line-height: 1;
      background: rgba(15,15,18,.55); color: #fff; opacity: .32; transition: opacity .15s;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    }
    .open:hover { opacity: .95; }
    .hidden { display: none !important; }
  `;

  function ensureOverlay(): boolean {
    const player = document.getElementById('movie_player') ?? document.querySelector('.html5-video-player');
    if (!player) return false;
    if (host && host.isConnected && host.parentElement === player) return true;
    host?.remove();
    host = document.createElement('div');
    host.id = 'subcast-overlay-host';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:65;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style>
      <div class="wrap hidden"><div class="box"><div class="orig"></div><div class="zh"></div></div></div>
      <button class="open" title="打开 SubCast 侧边栏">声渡</button>`;
    shadow.querySelector('.open')?.addEventListener('click', () => {
      try {
        void chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
      } catch {
        /* ignore */
      }
    });
    player.appendChild(host);
    lastRendered = '';
    return true;
  }

  function removeOverlay() {
    host?.remove();
    host = null;
    shadow = null;
  }

  function render(time: number) {
    if (!ensureOverlay() || !shadow) return;
    const wrap = shadow.querySelector('.wrap') as HTMLElement | null;
    const origEl = shadow.querySelector('.orig') as HTMLElement | null;
    const zhEl = shadow.querySelector('.zh') as HTMLElement | null;
    if (!wrap || !origEl || !zhEl) return;
    if (!overlayEnabled || !payload || payload.videoId !== currentVideoId() || !payload.segments.length) {
      wrap.classList.add('hidden');
      return;
    }
    const idx = activeIndex(payload.segments, time);
    if (idx < 0) {
      wrap.classList.add('hidden');
      return;
    }
    const orig = payload.segments[idx].text;
    const zh = payload.items?.[idx] ?? '';
    const mode = overlayMode;
    const showOrig = mode !== 'zh' || !zh;
    const showZh = mode !== 'original' && Boolean(zh);
    const key = `${idx}|${mode}|${showZh}|${showOrig}`;
    if (key === lastRendered) {
      wrap.classList.remove('hidden');
      return;
    }
    lastRendered = key;
    origEl.textContent = showOrig ? orig : '';
    zhEl.textContent = showZh ? zh : '';
    wrap.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Background messages                                                                              */
  /* ------------------------------------------------------------------------------------------------ */

  function onRuntimeMessage(msg: ContentEvent) {
    if (!msg?.type) return;
    if (msg.type === 'SUBTITLES') {
      if (msg.videoId !== currentVideoId()) return;
      payload = msg;
      overlayEnabled = msg.overlay;
      overlayMode = msg.overlayMode;
      lastRendered = '';
      const v = videoEl();
      render(v?.currentTime ?? 0);
      return;
    }
    if (msg.type === 'SEEK') {
      const v = videoEl();
      if (!v) return;
      v.currentTime = Math.max(0, msg.seconds);
      if (v.paused) void v.play().catch(() => {});
      lastRendered = '';
      render(v.currentTime);
      return;
    }
    if (msg.type === 'RESYNC') {
      if (lastMeta) sendMeta(lastMeta);
      window.postMessage({ source: 'subcast-content', type: 'RESYNC' }, '*');
      return;
    }
    if (msg.type === 'SETTINGS') {
      overlayEnabled = msg.overlay;
      overlayMode = msg.overlayMode;
      lastRendered = '';
      const v = videoEl();
      render(v?.currentTime ?? 0);
      return;
    }
    if (msg.type === 'CLEAR') {
      payload = null;
      lastRendered = '';
      const wrap = shadow?.querySelector('.wrap');
      wrap?.classList.add('hidden');
    }
  }

  window.addEventListener('message', onPageMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  connect();

  // 4 Hz is enough for a subtitle highlight and cheap for the service worker.
  setInterval(() => {
    const id = currentVideoId();
    if (id !== lastVideoId) {
      lastVideoId = id;
      payload = null;
      lastRendered = '';
      removeOverlay();
    }
    if (!id) {
      removeOverlay();
      return;
    }
    const v = videoEl();
    sendState();
    if (v) render(v.currentTime || 0);
    else ensureOverlay();
  }, 250);

  try {
    void chrome.runtime.sendMessage({ type: 'CONTENT_READY', videoId: currentVideoId(), url: location.href });
  } catch {
    /* worker starting */
  }

  },
});
