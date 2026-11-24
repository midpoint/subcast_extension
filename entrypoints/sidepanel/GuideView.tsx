import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import Markdown from '../../src/components/Markdown';

interface Props {
  text: string | null;
  loading: boolean;
  error: string;
  source?: 'shared' | 'llm' | 'cache';
  llmConfigured: boolean;
  onGenerate: (force: boolean) => void;
  onOpenSettings: () => void;
  onSeek: (seconds: number) => void;
}

const SOURCE_LABEL = { shared: '共享导读', llm: 'AI 生成', cache: '已缓存' } as const;

export default function GuideView({ text, loading, error, source, llmConfigured, onGenerate, onOpenSettings, onSeek }: Props) {
  if (loading) {
    return (
      <div className="guide-state">
        <Loader2 className="spin" size={26} />
        <p className="state-title">正在写导读</p>
        <p className="state-sub">长节目需要一点时间，可以切到问答或字幕继续看。</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="guide-state">
        <p className="state-title">导读没有生成</p>
        <p className="state-sub">{error}</p>
        <div className="state-actions">
          {!llmConfigured && (
            <button className="btn" type="button" onClick={onOpenSettings}>
              配置模型
            </button>
          )}
          <button className="btn btn-ghost" type="button" onClick={() => onGenerate(true)}>
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      </div>
    );
  }
  if (!text) {
    return (
      <div className="guide-state">
        <Sparkles size={28} className="accent" />
        <p className="state-title">一分钟看懂这一期</p>
        <p className="state-sub">一句话总结、时间线、核心观点和值得听的片段，全部带可跳转的时间戳。会先找共享导读，没有再用你的模型生成。</p>
        <div className="state-actions">
          <button className="btn btn-primary" type="button" onClick={() => onGenerate(false)}>
            生成导读
          </button>
          {!llmConfigured && (
            <button className="btn btn-ghost" type="button" onClick={onOpenSettings}>
              配置模型
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="guide">
      <div className="guide-bar">
        <span className="badge">{source ? SOURCE_LABEL[source] : '导读'}</span>
        <button className="icon-btn" type="button" title="重新生成" onClick={() => onGenerate(true)}>
          <RefreshCw size={14} />
        </button>
      </div>
      <Markdown text={text} onSeek={onSeek} />
    </div>
  );
}
