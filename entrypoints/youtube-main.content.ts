/** Runs in the page's own JS world (world: MAIN) because `ytInitialPlayerResponse` and the player's
 *  `getPlayerResponse()` only exist there. It forwards the player response to the isolated content
 *  script with postMessage; it never talks to extension APIs. */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const SOURCE = 'subcast-page';
    let lastPostedId = '';
    let lastPostedAt = 0;

    const currentId = (): string | null => {
      try {
        const u = new URL(location.href);
        const v = u.searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
        const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
        return m?.[1] ?? null;
      } catch {
        return null;
      }
    };

    const postPlayer = (player: any) => {
      const id: string | undefined = player?.videoDetails?.videoId;
      if (!id) return;
      const now = Date.now();
      if (id === lastPostedId && now - lastPostedAt < 1500) return;
      lastPostedId = id;
      lastPostedAt = now;
      window.postMessage({ source: SOURCE, type: 'PLAYER', videoId: id, playerResponse: player }, '*');
    };

    const readPagePlayer = () => {
      const playerEl = document.getElementById('movie_player') as any;
      try {
        const pr = playerEl?.getPlayerResponse?.();
        if (pr?.videoDetails?.videoId) {
          postPlayer(pr);
          return true;
        }
      } catch {
        /* player not ready */
      }
      const initial = (window as any).ytInitialPlayerResponse;
      if (initial?.videoDetails?.videoId) {
        postPlayer(initial);
        return true;
      }
      return false;
    };

    // YouTube fetches /youtubei/v1/player on every SPA navigation; capture the response there.
    try {
      const origFetch = window.fetch;
      if (origFetch && !(origFetch as any).__subcastWrapped) {
        const wrapped = function (this: any, ...args: Parameters<typeof fetch>) {
          return origFetch.apply(this, args).then((res) => {
            try {
              const input = args[0];
              const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
              if (url.includes('/youtubei/v1/player')) {
                res.clone().json().then(postPlayer).catch(() => {});
              }
            } catch {
              /* never break the page */
            }
            return res;
          });
        };
        (wrapped as any).__subcastWrapped = true;
        window.fetch = wrapped as typeof fetch;
      }
    } catch {
      /* some pages freeze fetch; initial response still works */
    }

    document.addEventListener('yt-navigate-finish', () => {
      lastPostedId = '';
      window.postMessage({ source: SOURCE, type: 'NAV', videoId: currentId(), url: location.href }, '*');
      setTimeout(readPagePlayer, 300);
      setTimeout(readPagePlayer, 1500);
    });

    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window) return;
      const data = e.data as { source?: string; type?: string } | null;
      if (data?.source === 'subcast-content' && data.type === 'RESYNC') {
        if (!readPagePlayer()) {
          window.postMessage({ source: SOURCE, type: 'NAV', videoId: currentId(), url: location.href }, '*');
        }
      }
    });

    // The first response is set before content scripts run on a full page load.
    if (!readPagePlayer()) {
      let tries = 0;
      const t = setInterval(() => {
        if (readPagePlayer() || ++tries > 40) clearInterval(t);
      }, 250);
    }
    document.addEventListener('DOMContentLoaded', readPagePlayer);
    window.addEventListener('load', readPagePlayer);
  },
});
