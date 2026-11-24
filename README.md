# SubCast · 声渡 — Chrome 插件版

把 YouTube 视频变成「双语字幕 + AI 导读 + 带时间戳的问答」的 Chrome Manifest V3 插件。它是桌面版 [SubCast](https://github.com/joeseesun/subcast) 的浏览器实现，复用同一套字幕数据模型和共享服务，但不是桌面版的替代品：没有本地识别、没有 yt-dlp、没有订阅和下载。

- 只在 `https://www.youtube.com/*` 注入内容脚本；所有网络请求都在扩展的 background / offscreen 里完成。
- 侧边栏是主界面：字幕列表、导读、问答；视频页上另有一层可开关的双语字幕。
- 有官方字幕用官方，没有就找共享字幕库，再没有才由用户自己的 Groq / OpenAI Key 做云端识别。
- 翻译默认用 Google 免费接口，中国大陆网络会自动走 `elon.qiaomu.ai` 的中转；也可以改成任意 OpenAI 兼容模型。
- 字幕、译文、导读、问答都存在 IndexedDB，重新打开同一期直接命中缓存。

## 构建与加载

要求 Node.js 20+、Chrome/Chromium 116+。

```bash
cd extension
npm install
npm run build          # 产物在 extension/.output/chrome-mv3
```

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择 `extension/.output/chrome-mv3`。
3. 打开任意 YouTube 视频，点地址栏右侧的 SubCast 图标打开侧边栏；视频右下角也会出现「声渡」浮层入口。

开发模式：

```bash
npm run dev            # WXT 开发服务器，改代码自动重载
npx tsc --noEmit       # 类型检查
npx vitest run         # 单元测试
```

> 侧边栏需要通过工具栏图标打开。扩展页可以直接访问 `chrome-extension://<id>/sidepanel.html?tabId=<tabId>` 用于调试；正常使用时不要带这个参数。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` / `unlimitedStorage` | 设置、Key、字幕、译文、导读、问答记录 |
| `sidePanel` | 侧边栏主界面 |
| `offscreen` | 整集翻译、云端识别的长任务，避免 MV3 service worker 被回收 |
| `tabs` / `scripting` | 跟踪当前 YouTube 标签页、向内容脚本发消息 |
| `https://www.youtube.com/*` | 读页面里的播放器信息、取字幕和音频格式 |
| `https://*.googlevideo.com/*` | 只有用户开启云端识别时下载音频 |
| `https://subcast.qiaomu.ai/*` | 共享字幕 / 共享导读的查询与上传 |
| `https://translate.googleapis.com/*`、`https://elon.qiaomu.ai/*` | Google 翻译及中国大陆中转 |
| `https://api.groq.com/*`、`https://api.openai.com/*` | 用户 Key 的云端语音识别 |
| 可选的 `https://*/*`、`http://*/*` | 用户填写自定义模型 Base URL 时，在设置页点击保存/测试后按需申请该域名 |

内容脚本不做任何跨域请求；它只读当前页面、接收 background 的消息、渲染浮层。

## 架构

```
youtube-main.content.ts   MAIN world，document_start：读 ytInitialPlayerResponse / getPlayerResponse()
        │ postMessage
youtube.content.ts        隔离世界：把视频信息和播放时间通过 Port 发给 background，渲染 Shadow DOM 浮层
        │ chrome.runtime Port
background.ts             service worker：唯一的网络协调者；决定共享/官方/自动字幕，启动翻译和识别
        ├─ offscreen.html 长任务：批量翻译、音频下载 + Web Audio 解码 + WAV 分片 + 识别上传
        ├─ IndexedDB      episodes / guides / chats
        └─ chrome.storage.local  设置、Key、匿名 install id
sidepanel/                字幕列表（高亮、点击跳转）、导读、问答
options/                  翻译引擎、共享开关、云端识别、Key 风险提示、缓存清理
```

数据模型和桌面版一致：

- `EpisodeRecord.segments = [{ start, end, text }]`
- `translation.items` 与 `segments` 一一对应，未翻译是 `null`，不能丢行
- episode key：`yt:<videoId>`；桌面版的 `guid:`、`audio:`、`qm:` 保留在类型/共享接口中，浏览器版目前只产生 `yt:`
- 字幕来源：`official`（官方）、`youtube-auto`（YouTube 自动字幕）、`shared`（共享库）、`cloud`（用户 Key 云端识别）

## 隐私与数据流

| 数据 | 去哪里 | 什么时候 |
| --- | --- | --- |
| YouTube 页面里的标题、字幕列表、播放状态 | 只在本机扩展进程间传递 | 打开视频时 |
| 字幕文本 | Google 翻译 / `elon.qiaomu.ai` 中转 | 使用 Google 引擎翻译时；只发字幕文本 |
| 字幕 + 导读/问答提示词 | 用户自己配置的模型服务 | 生成导读或问答时；Key 只放在 `Authorization` 头里发给该服务 |
| episode key | `subcast.qiaomu.ai` | 查询共享字幕/导读时 |
| 云端识别得到的字幕文本 + 译文 | `subcast.qiaomu.ai` | 仅在「共享字幕」开关打开且来源是 `cloud` 时上传；**从不上传音频** |
| 音频 | 用户配置的 Groq / OpenAI | 仅在用户主动点「用云端识别」并确认后；默认关闭，可在设置里全局关掉 |
| Key、设置、匿名 install id | 本机 `chrome.storage.local` | 不上传到任何 SubCast 服务 |

- 没有账号、没有埋点、没有远程配置。
- Key 存在扩展的 `chrome.storage.local`，**不是系统钥匙串**；能访问该浏览器配置的人/恶意扩展有可能读到。设置页有明确提示。桌面版用系统钥匙串，这是浏览器版与桌面版的一个已知差异。
- 共享上传的 `source` 只会是 `cloud`，不会把浏览器版伪装成桌面版的 `whisper` / `qwen3`；上传体里没有音频、没有 YouTube 音频 URL。

## 与桌面版的差异

| 能力 | 桌面版 | 浏览器版 |
| --- | --- | --- |
| 平台 | macOS / Windows / Linux 桌面 App | Chrome MV3 扩展（Chrome 116+） |
| YouTube 双语字幕 / 导读 / 问答 | 有 | 有（P0 / P1） |
| 本地 Whisper / 本地识别 | 有 | **没有**；只能用自己的 Key 走云端识别 |
| yt-dlp / 本地下载 / 离线播放 | 有 | **没有**；音频只通过 YouTube 的播放器格式在用户开启识别时临时读取 |
| 订阅、RSS、小宇宙、Apple Podcasts 页面 | 有 | **未实现**（P2 范围，本次不做） |
| 高亮、历史 | 有 | **未实现**（P2 范围） |
| 系统钥匙串 | 有 | 没有，Key 存扩展本地存储 |
| 共享字幕 | 查询 + 上传本地识别结果 | 查询 + 上传云端识别结果；官方/自动字幕不上传 |
| 后台长任务 | Rust 进程 | offscreen document + service worker 协调 |

## 本次范围与验收

- P0（YouTube 双语字幕链）：已完成。真实 Google 中转翻译、三种字幕形态、5 次跳转、60 分钟量级对齐与断点续译、重开缓存均验证。详见 [reports/P0.md](reports/P0.md)。
- P1（导读 / 问答 / 共享 / 云端识别）：已完成代码与本地协议级验收；导读和问答用 OpenAI 兼容 mock 服务验证，共享上传和云端识别用同协议 mock 验证，真实共享库只验证了 404 / exists。详见 [reports/P1.md](reports/P1.md)。
- P2（小宇宙 / Apple Podcasts 网页、轻量 RSS 订阅、高亮）：未做。

### 已知限制（如实记录）

1. **真实 YouTube 站点验收受阻**：本机直连 YouTube 超时；唯一可用的代理出口 IP（45.32.73.17）被 YouTube 要求登录验证（`LOGIN_REQUIRED: Sign in to confirm you're not a bot`），WEB 和 ANDROID/IOS/ANDROID_VR InnerTube 客户端都是同样结果。因此 P0 的「3 个真实视频」用本地 HTTPS fixture 完成了完整链路验收，fixture 的响应形状、字幕 URL、InnerTube 播放器响应都按 YouTube 协议构造；真实站点还需要在能正常访问 YouTube 的浏览器/网络里补一次。证据见 [reports/evidence/live-youtube-blocker.log](reports/evidence/live-youtube-blocker.log)。
2. **Google 翻译中转是第三方免费服务**：本机实测可用（3 句真实翻译 13.1 秒，含 6 秒直连探测超时），但它可能限流或返回 429；长集翻译验收用同协议的本地 mock 保证确定性。用户可在设置里改用 DeepSeek 等模型翻译。
3. **云端识别没有真实 Key 实测**：音频下载、Web Audio 解码、WAV 分片、上传、识别结果入库、自动翻译、共享上传整条链路用本地 mock ASR 跑通；没有向真实 Groq/OpenAI 发过音频，也没有产生费用。真实音频只会在用户主动确认后发给他配置的服务。
4. **共享库没有真实命中数据**：真实 `subcast.qiaomu.ai` 对测试 key 返回 404，`/transcripts/exists` 返回 200 + `found: []`；共享命中、共享导读、上传后可见性用同协议本地 mock 验证。
5. 翻译引擎在「直连 Google 失败 → 中转」之间会先等一次 6 秒探测；这是为了不把整集翻译卡在不可达的 Google 上，代价是中国大陆网络下第一次翻译多等几秒。

## 开发检查

```bash
cd extension
npx tsc --noEmit
npx vitest run
npm run build
```

本次分支上的结果：TypeScript 无错误，Vitest 22/22 通过，构建产物约 368 KB。

## 许可

本项目沿用上游 [SubCast](https://github.com/joeseesun/subcast) 的 **AGPL-3.0** 许可（见仓库根目录 [LICENSE](../LICENSE)）。本目录是基于上游代码和产品设计的修改版；如果你分发本插件或其修改版，需要按 AGPL-3.0 提供对应源代码和许可声明，并保留上游署名与仓库链接。原始项目：<https://github.com/joeseesun/subcast>。

SubCast 与 YouTube、Google、Groq、OpenAI 没有隶属关系。使用本插件时请遵守相应服务的条款。
