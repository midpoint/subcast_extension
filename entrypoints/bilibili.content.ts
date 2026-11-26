/** Bilibili video pages: the extension is YouTube-only. Say so once instead of doing nothing,
 *  because a silent no-op looks like a bug. Shown at most once a week. */

const SNOOZE_KEY = 'subcast-bilibili-notice';
const WEEK = 7 * 24 * 3600 * 1000;
const VIDEO_PATH = /^\/(?:video\/|bangumi\/play\/|list\/)/;

const CSS = `
  :host { all: initial; }
  .card {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: flex-start; gap: 10px; max-width: 320px;
    padding: 12px 14px; border-radius: 12px; background: rgba(17, 17, 20, .95); color: #fff;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
  }
  .logo {
    flex: none; width: 22px; height: 22px; border-radius: 6px; background: #e5484d;
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
  }
  .copy { min-width: 0; }
  .title { margin: 0; font-size: 13px; font-weight: 600; }
  .sub { margin: 2px 0 0; font-size: 12px; opacity: .72; }
  .close {
    flex: none; border: 0; background: transparent; color: #8ab4ff; cursor: pointer;
    padding: 0; margin-left: 4px; font-size: 12px; font-family: inherit;
  }
`;

function snoozed(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(SNOOZE_KEY) ?? 0) < WEEK;
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()));
  } catch {
    /* private mode: the notice may show again next time */
  }
}

function show() {
  snooze();
  const host = document.createElement('div');
  host.id = 'subcast-bilibili-notice';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="card" role="status">
      <div class="logo">声</div>
      <div class="copy">
        <p class="title">SubCast 还不支持 B 站</p>
        <p class="sub">B 站视频暂不支持字幕、导读和问答；YouTube、YouTube Music 和播客单集可以用。</p>
      </div>
      <button class="close" type="button">知道了</button>
    </div>`;
  const hide = () => host.remove();
  shadow.querySelector('.close')?.addEventListener('click', hide);
  (document.body ?? document.documentElement).appendChild(host);
  setTimeout(hide, 20_000);
}

export default defineContentScript({
  matches: ['https://www.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    if (snoozed()) return;

    // Video pages can also be reached through Bilibili's in-page navigation.
    const check = () => {
      if (!VIDEO_PATH.test(location.pathname)) return false;
      if (document.getElementById('subcast-bilibili-notice')) return true;
      show();
      return true;
    };
    if (check()) return;
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, 1000);
  },
});
