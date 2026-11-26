import { Check, Copy, ExternalLink, Eye, EyeOff, Info, KeyRound, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { clearCachedEpisodes, storageInfo } from '../../src/lib/db';
import { requestOrigins } from '../../src/lib/permissions';
import { ASR_PRESETS, getSettings, LLM_PRESETS, saveSettings } from '../../src/lib/settings';
import type { DisplayMode, ExtensionSettings } from '../../src/lib/types';

type StoreInfo = { episodes: number; guides: number; bytes: number };

const LANGUAGES: { id: string; name: string }[] = [
  { id: 'auto', name: '自动检测' },
  { id: 'en', name: '英语' },
  { id: 'zh', name: '中文' },
  { id: 'ja', name: '日语' },
  { id: 'ko', name: '韩语' },
  { id: 'es', name: '西班牙语' },
  { id: 'fr', name: '法语' },
  { id: 'de', name: '德语' },
  { id: 'it', name: '意大利语' },
  { id: 'pt', name: '葡萄牙语' },
  { id: 'ru', name: '俄语' },
];

function sendToBackground<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
        <span className="knob" />
      </button>
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function Options() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getSettings().then(setSettings);
    void storageInfo().then(setStore).catch(() => setStore(null));
  }, []);

  const set = (patch: Partial<ExtensionSettings>) => setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  const setLlm = (patch: Partial<ExtensionSettings['llm']>) =>
    setSettings((prev) => (prev ? { ...prev, llm: { ...prev.llm, ...patch } } : prev));

  const preset = useMemo(
    () => LLM_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, '') === (settings?.llm.baseUrl ?? '').replace(/\/+$/, '')),
    [settings?.llm.baseUrl],
  );

  if (!settings) {
    return (
      <div className="loading">
        <Loader2 className="spin" size={22} />
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError('');
    setTestMsg('');
    try {
      const urls: string[] = [];
      if (settings.translateEngine === 'llm' || settings.llm.baseUrl) urls.push(settings.llm.baseUrl);
      // Ask for the host permission inside the click gesture, before any other await.
      const granted = await requestOrigins(urls);
      if (!granted) throw new Error('需要允许扩展访问模型服务的地址，否则浏览器会拦截请求');
      if (settings.translateEngine === 'llm') {
        if (!settings.llm.baseUrl.trim()) throw new Error('请填写模型服务的 Base URL');
        if (!settings.llm.model.trim()) throw new Error('请填写模型名');
      }
      const next = await saveSettings(settings);
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testLlm = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const granted = await requestOrigins([settings.llm.baseUrl]);
      if (!granted) throw new Error('没有获得访问该地址的权限');
      const res = await sendToBackground<{ ok: boolean; message: string }>({ type: 'TEST_LLM', llm: settings.llm });
      setTestMsg(res.ok ? `连接成功：${res.message}` : `连接失败：${res.message}`);
    } catch (e) {
      setTestMsg(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const clear = async () => {
    await clearCachedEpisodes();
    setStore(await storageInfo());
    setConfirmClear(false);
  };

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo">声</span>
          <div>
            <h1>SubCast 设置</h1>
            <p>声渡 Chrome 插件 · YouTube、YouTube Music 与播客的双语字幕、导读与问答</p>
          </div>
        </div>
        <div className="top-actions">
          <button className="btn ghost" type="button" onClick={() => chrome.runtime.openOptionsPage()} hidden />
          <a className="btn ghost" href="https://github.com/joeseesun/subcast" target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> 原项目
          </a>
          <button className="btn primary" type="button" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : null}
            {saved ? '已保存' : '保存设置'}
          </button>
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}

      <main>
        <section className="card">
          <h2>翻译引擎</h2>
          <p className="section-sub">整集字幕会分批翻译，译文和原文逐句对齐。中途关掉页面，下次打开继续。</p>
          <div className="radio-grid">
            <button className={`choice ${settings.translateEngine === 'google' ? 'on' : ''}`} type="button" onClick={() => set({ translateEngine: 'google' })}>
              <span className="choice-title">谷歌翻译（默认）</span>
              <span className="choice-sub">免费、不用 Key。中国大陆会自动走国内中转。</span>
            </button>
            <button className={`choice ${settings.translateEngine === 'llm' ? 'on' : ''}`} type="button" onClick={() => set({ translateEngine: 'llm' })}>
              <span className="choice-title">我自己的模型</span>
              <span className="choice-sub">更自然，按量付费。下面填一个 OpenAI 兼容接口即可。</span>
            </button>
          </div>

          <div className={`llm-box ${settings.translateEngine === 'llm' ? 'active' : ''}`}>
            <div className="preset-row">
              <span className="field-label">快速预设</span>
              <div className="presets">
                {LLM_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`chip ${preset?.id === p.id ? 'on' : ''}`}
                    onClick={() => setLlm({ baseUrl: p.baseUrl, model: p.model })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="two">
              <Field label="Base URL" hint="例如 https://api.deepseek.com/v1">
                <input value={settings.llm.baseUrl} onChange={(e) => setLlm({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
              </Field>
              <Field label="模型名">
                <input value={settings.llm.model} onChange={(e) => setLlm({ model: e.target.value })} placeholder="deepseek-chat" spellCheck={false} />
              </Field>
            </div>
            <Field label="API Key" hint={preset ? `在 ${preset.name} 的控制台创建，只保存在这台电脑的扩展存储里` : '只保存在这台电脑的扩展存储里'}>
              <div className="key-row">
                <KeyRound size={14} className="key-icon" />
                <input
                  type={showKey ? 'text' : 'password'}
                  value={settings.llm.apiKey}
                  onChange={(e) => setLlm({ apiKey: e.target.value })}
                  placeholder={settings.llm.baseUrl.includes('127.0.0.1') || settings.llm.baseUrl.includes('localhost') ? '本机模型可以留空' : 'sk-…'}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="icon-btn" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>
            <div className="test-row">
              <button className="btn ghost" type="button" onClick={testLlm} disabled={testing}>
                {testing ? <Loader2 size={14} className="spin" /> : null}
                测试连接
              </button>
              {preset && (
                <a className="link" href={preset.keyUrl} target="_blank" rel="noreferrer">
                  获取 Key <ExternalLink size={12} />
                </a>
              )}
              {testMsg && <span className={`test-msg ${testMsg.startsWith('连接成功') ? 'ok' : 'bad'}`}>{testMsg}</span>}
            </div>
          </div>
        </section>

        <section className="card">
          <h2>字幕与显示</h2>
          <Toggle on={settings.autoTranslate} onChange={(v) => set({ autoTranslate: v })} label="打开视频后自动翻译" hint="关掉后可以在侧边栏里手动点「翻译成中文」。" />
          <Toggle
            on={settings.autoPunctuate}
            onChange={(v) => set({ autoPunctuate: v })}
            label="给中文字幕自动补标点"
            hint="YouTube 中文字幕或中文译文缺少标点时自动补全，只加标点、不改字。配了模型就用模型（会产生少量费用），没配模型时用本地规则补句末标点和常见句间逗号。"
          />
          <Toggle on={settings.overlay} onChange={(v) => set({ overlay: v })} label="在视频画面上显示字幕" hint="除了侧边栏列表，也在播放器上显示当前这一句。" />
          <Field label="默认显示方式">
            <select value={settings.displayMode} onChange={(e) => set({ displayMode: e.target.value as DisplayMode })}>
              <option value="bilingual">双语（原文 + 中文）</option>
              <option value="zh">中文</option>
              <option value="original">原文</option>
            </select>
          </Field>
        </section>

        <section className="card">
          <h2>共享字幕</h2>
          <p className="section-sub">别人识别或整理过的字幕，打开就能直接用。只共享字幕文本和中文译文，永远不上传音频。</p>
          <Toggle on={settings.useShared} onChange={(v) => set({ useShared: v })} label="优先使用共享字幕" hint="打开视频时先查 subcast.qiaomu.ai，命中就直接显示。" />
          <Toggle
            on={settings.shareTranscripts}
            onChange={(v) => set({ shareTranscripts: v })}
            label="把我的云端识别结果共享出去"
            hint="只在你自己用云端识别（Groq / OpenAI）产生新字幕时上传；带一个随机安装编号，不含账号信息。"
          />
        </section>

        <section className="card">
          <h2>云端识别（没有字幕时）</h2>
          <p className="section-sub">YouTube 没有字幕、共享库里也没有时，或者播客单集（小宇宙、Apple Podcasts、喜马拉雅没有字幕轨），可以把音频发给你自己的识别服务转写；中文视频只有英文自动字幕时也会自动改用这里识别。音频只发给下面选的服务。</p>
          <Field label="识别服务">
            <select
              value={settings.asrEngine}
              onChange={(e) => {
                const v = e.target.value as ExtensionSettings['asrEngine'];
                set({ asrEngine: v, asrModel: v === 'off' ? '' : ASR_PRESETS[v].model });
              }}
            >
              <option value="off">关闭</option>
              <option value="groq">Groq Whisper</option>
              <option value="openai">OpenAI Whisper</option>
            </select>
          </Field>
          {settings.asrEngine !== 'off' && (
            <>
              <Field label={`${ASR_PRESETS[settings.asrEngine].name} API Key`} hint="只保存在扩展存储里，只发给你选择的识别服务。">
                <input
                  type="password"
                  value={settings.asrKey}
                  onChange={(e) => set({ asrKey: e.target.value })}
                  placeholder="gsk_… / sk-…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <div className="two">
                <Field label="模型" hint="一般不用改">
                  <input value={settings.asrModel} onChange={(e) => set({ asrModel: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="音频语言" hint="自动检测通常也够用">
                  <select value={settings.asrLanguage} onChange={(e) => set({ asrLanguage: e.target.value })}>
                    {LANGUAGES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="inline-note">
                <Info size={14} />
                音频按约 8 分钟切块上传（每块小于 25 MB）。会员、直播或受限制的视频可能拿不到音频流；小宇宙的付费/私密单集、喜马拉雅的付费/私密专辑拿不到公开音频。Apple Podcasts 只公开一档节目最近 200 集，较早的单集可能无法生成；Spotify 音频有 DRM 加密，暂不支持。
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h2>隐私与数据</h2>
          <div className="inline-note warn">
            <ShieldCheck size={14} />
            Key 存放在 <code>chrome.storage.local</code>，只在本机、只发给上面配置的服务。浏览器扩展存储不像系统钥匙串那样加密，介意的话请用单独的、限额的 Key。
          </div>
          <dl className="facts">
            <div>
              <dt>安装编号</dt>
              <dd>
                <code>{settings.installId}</code>
                <button
                  type="button"
                  className="icon-btn"
                  title="复制"
                  onClick={async () => {
                    await navigator.clipboard.writeText(settings.installId);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </dd>
            </div>
            <div>
              <dt>本地缓存</dt>
              <dd>
                {store ? `${store.episodes} 集字幕 · ${store.guides} 份导读 · ${bytes(store.bytes)}` : '读取中…'}
              </dd>
            </div>
            <div>
              <dt>网络请求</dt>
              <dd>全部走扩展后台，不经 YouTube 页面上下文；浏览器自己的代理设置直接生效。</dd>
            </div>
          </dl>
          <div className="danger-row">
            {confirmClear ? (
              <>
                <span className="hint">会删除所有已缓存字幕、译文和导读，对话保留。</span>
                <button className="btn danger" type="button" onClick={clear}>
                  确认清空
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button className="btn ghost" type="button" onClick={() => setConfirmClear(true)}>
                <Trash2 size={14} /> 清空字幕缓存
              </button>
            )}
          </div>
        </section>

        <section className="card about">
          <h2>关于</h2>
          <p>
            本扩展衍生自 <a href="https://github.com/joeseesun/subcast" target="_blank" rel="noreferrer">SubCast（声渡）</a> 桌面版，以 AGPL-3.0 开源。
            桌面端的本机 ASR、离线下载、系统钥匙串等能力在插件形态下不成立，未包含。
          </p>
          <p className="hint">
            版本 {chrome.runtime.getManifest().version} · 字幕与译文缓存保存在 IndexedDB · 共享字幕服务地址 subcast.qiaomu.ai
          </p>
        </section>
      </main>

      <footer className="bottom">
        <span className="hint">设置保存在本机，不会同步到云端。</span>
        <button className="btn primary" type="button" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : null}
          {saved ? '已保存' : '保存设置'}
        </button>
      </footer>
    </div>
  );
}
