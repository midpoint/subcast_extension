import { Check, Copy, CornerUpLeft, Loader2, MessageCircle, Plus, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from '../../src/components/Markdown';
import type { ChatTurn } from '../../src/lib/types';

interface Props {
  messages: ChatTurn[];
  pending: boolean;
  error: string;
  llmConfigured: boolean;
  onSend: (question: string) => void;
  onCancel: () => void;
  onRetry: (assistantIndex: number) => void;
  onNew: () => void;
  onSeek: (seconds: number) => void;
  onOpenSettings: () => void;
}

const QUICK: { label: string; question: string }[] = [
  { label: '这期讲了什么', question: '用三句话概括这一期讲了什么，并给出最关键的三个时间戳。' },
  { label: '最有价值的观点', question: '列出这期最有信息量的 5 个观点，按重要性排序。每条写：一句加粗的观点、理由、时间戳。' },
  { label: '嘉宾是谁', question: '嘉宾是谁？结合节目内容介绍他的身份、经历和代表作，说明他为什么有资格谈这个话题。节目里没提到、属于常识补充的内容请标出来。' },
  { label: '反直觉的地方', question: '这期有哪些反直觉或有争议的观点？逐条说明：通常大家怎么看、嘉宾怎么说、他的理由站不站得住。' },
];

const stripTimestamps = (text: string) =>
  text.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\s*[-–—]\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\])?/g, '').replace(/[ \t]{2,}/g, ' ');

function CopyButton({ text, title, label }: { text: string; title: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard denied */
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{label}</span>}
    </button>
  );
}

export default function ChatView({ messages, pending, error, llmConfigured, onSend, onCancel, onRetry, onNew, onSeek, onOpenSettings }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [input]);

  const send = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    setInput('');
    onSend(q);
  };

  if (!messages.length && !pending) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <MessageCircle size={28} className="accent" />
          <p className="state-title">直接问这一期</p>
          <p className="state-sub">回答只基于本期文字稿，引用会带可点击的时间戳。</p>
          {!llmConfigured && (
            <button className="btn btn-ghost" type="button" onClick={onOpenSettings}>
              先配置模型
            </button>
          )}
          <div className="quick-grid">
            {QUICK.map((q) => (
              <button key={q.label} type="button" className="quick" disabled={!llmConfigured} onClick={() => send(q.question)}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <div className="composer">
          <textarea
            ref={area}
            value={input}
            rows={1}
            placeholder={llmConfigured ? '问这一期的任何问题…' : '先到设置里配置模型 Key'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button className="send" type="button" disabled={!input.trim() || !llmConfigured || pending} onClick={() => send(input)}>
            发送
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-bar">
        <span className="muted">{messages.length} 条对话</span>
        <button className="icon-btn" type="button" title="新对话" onClick={onNew}>
          <Plus size={14} /> 新对话
        </button>
      </div>
      <div className="chat-list">
        {messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div className="msg user" key={i}>
                <div className="bubble user-bubble">{m.content}</div>
              </div>
            );
          }
          const isLast = i === messages.length - 1;
          const streaming = pending && isLast;
          return (
            <div className="msg assistant" key={i}>
              <div className="assistant-card">
                {m.content ? (
                  <Markdown text={m.content} onSeek={onSeek} dense />
                ) : (
                  <div className="thinking">
                    <Loader2 className="spin" size={14} /> 正在读文字稿…
                  </div>
                )}
                {streaming && m.content && <span className="cursor" />}
                {!streaming && m.content && (
                  <div className={`msg-actions ${expanded ? 'open' : ''}`}>
                    <CopyButton text={m.content} title="复制回答" label="复制" />
                    <CopyButton text={stripTimestamps(m.content)} title="复制（不带时间戳）" label="无时间戳" />
                    <button className="icon-btn" type="button" title="重新回答" onClick={() => onRetry(i)}>
                      <CornerUpLeft size={13} /> 重答
                    </button>
                    {m.model && <span className="msg-model">{m.model}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {error && <div className="chat-error">{error}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          rows={1}
          placeholder={pending ? '正在回答…' : '继续追问…'}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setExpanded(true)}
          onBlur={() => setExpanded(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {pending ? (
          <button className="send stop" type="button" onClick={onCancel}>
            <Square size={12} /> 停止
          </button>
        ) : (
          <button className="send" type="button" disabled={!input.trim()} onClick={() => send(input)}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
