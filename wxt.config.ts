import { defineConfig } from 'wxt';

// Chrome-first MV3 extension. Every network request lives in the background service worker or the
// offscreen document, which use this manifest's host permissions instead of the page's CORS rules.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SubCast · 声渡 — YouTube 双语字幕',
    description: 'YouTube 双语字幕、AI 导读和带时间戳的 AI 问答。共享字幕优先，没有官方字幕时可用自己的 Key 走云端识别。',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'offscreen', 'tabs', 'scripting'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://*.googlevideo.com/*',
      'https://subcast.qiaomu.ai/*',
      'https://translate.googleapis.com/*',
      'https://elon.qiaomu.ai/*',
      'https://api.groq.com/*',
      'https://api.openai.com/*',
    ],
    // User-configured LLM / ASR endpoints are granted from the options page when the user saves them.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: '打开 SubCast 侧边栏' },
    side_panel: { default_path: 'sidepanel.html' },
    options_ui: { page: 'options.html', open_in_tab: true },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
  },
});
