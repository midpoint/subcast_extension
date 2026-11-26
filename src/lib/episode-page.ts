/** Runs a content script on a page whose media has no caption track (podcast episode, X video
 *  post). The sites all have the same shape: no caption tracks, client-side navigation between
 *  episodes, and an optional <audio>/<video> element the panel can seek. Each site only supplies
 *  URL → id, metadata from its own DOM, and (when available) the player element; the connection,
 *  navigation polling and floating button live here. */
import type { ContentEvent } from './messages';
import type { VideoMeta } from './types';

const BTN_CSS = `
  :host { all: initial; }
  .btn {
    display: flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
    padding: 7px 12px; border-radius: 999px; color: #fff; background: rgba(17, 17, 20, .92);
    font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .3);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
  .btn:hover { background: rgba(30, 30, 36, .98); }
`;

export interface EpisodePageAdapter {
  /** Full extension episode id (`qm:…`, `pod:ap:…`), or null when the URL is not an episode page. */
  videoIdFromUrl(url: string): string | null;
  /** Reads what the page exposes. Must resolve: fall back to the document title if the DOM has not
   *  rendered yet, because the background fills in the audio URL separately. */
  resolveMeta(videoId: string): Promise<VideoMeta>;
  /** The site's own player, when it is a plain <audio> or <video> element. */
  player?: () => HTMLMediaElement | null;
  /** Show the floating "open panel" button (default true). */
  button?: boolean;
}

export function serveEpisodePage(page: EpisodePageAdapter): void {
  let port: chrome.runtime.Port | null = null;
  let currentId: string | null = null;
  let meta: VideoMeta | null = null;
  let entering = 0;
  let button: HTMLDivElement | null = null;

  function sendMeta() {
    if (!meta) return;
    try {
      port?.postMessage({ type: 'META', meta });
    } catch {
      /* reconnect will resend */
    }
  }

  function sendState() {
    if (!currentId || !port || !page.player) return;
    const media = page.player();
    try {
      port.postMessage({
        type: 'STATE',
        videoId: currentId,
        time: media?.currentTime || 0,
        duration: Number.isFinite(media?.duration) ? media!.duration : meta?.duration || 0,
        paused: media?.paused ?? true,
      });
    } catch {
      /* port closing */
    }
  }

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
    if (meta) sendMeta();
    sendState();
  }

  function ensureButton() {
    if (page.button === false || button?.isConnected) return;
    button = document.createElement('div');
    button.id = 'subcast-panel-host';
    button.style.cssText = 'position:fixed;right:20px;bottom:96px;z-index:2147483646;';
    const shadow = button.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${BTN_CSS}</style><button class="btn" type="button" title="打开 SubCast 侧边栏"><span class="dot"></span>声渡</button>`;
    shadow.querySelector('button')?.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }).catch(() => {});
      } catch {
        /* worker starting */
      }
    });
    (document.body ?? document.documentElement).appendChild(button);
  }

  function removeButton() {
    button?.remove();
    button = null;
  }

  function inform(videoId: string | null) {
    try {
      chrome.runtime
        .sendMessage({ type: 'CONTENT_READY', videoId, url: location.href })
        .catch(() => {});
    } catch {
      /* worker starting */
    }
  }

  async function enter(videoId: string) {
    const token = ++entering;
    currentId = videoId;
    meta = null;
    ensureButton();
    let next: VideoMeta;
    try {
      next = await page.resolveMeta(videoId);
    } catch {
      return;
    }
    if (token !== entering || currentId !== videoId) return;
    meta = next;
    sendMeta();
    inform(videoId);
    sendState();
  }

  function leave() {
    entering++;
    currentId = null;
    meta = null;
    removeButton();
    inform(null);
  }

  function onRuntimeMessage(msg: ContentEvent) {
    if (msg.type === 'SEEK') {
      const media = page.player?.();
      if (!media) return;
      media.currentTime = Math.max(0, msg.seconds);
      if (media.paused) void media.play().catch(() => {});
      return;
    }
    if (msg.type === 'RESYNC' && meta) sendMeta();
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  connect();

  // Every supported site navigates between episodes without reloading the page.
  const follow = () => {
    const id = page.videoIdFromUrl(location.href);
    if (id === currentId) return;
    if (id) void enter(id);
    else leave();
  };
  setInterval(follow, 500);
  if (page.player) setInterval(sendState, 250);
  follow();
}
