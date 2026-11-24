/** Minimal OpenAI-compatible chat client. Runs in the background/offscreen documents, which use the
 *  manifest's host permissions, so providers never need CORS headers. */
import type { LlmConfig } from './types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  timeoutMs?: number;
}

export function chatUrl(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (!b) throw new Error('没有填写模型服务的 Base URL');
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

export function llmReady(cfg: LlmConfig): boolean {
  if (!cfg.baseUrl.trim() || !cfg.model.trim()) return false;
  try {
    const host = new URL(cfg.baseUrl).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  } catch {
    return false;
  }
  return Boolean(cfg.apiKey.trim());
}

export function isKeyError(message: string): boolean {
  return /\b(401|403)\b|api key|api_key|unauthori[sz]ed|invalid key|authentication/i.test(message);
}

function errorText(status: number, body: string): string {
  let detail = body.trim();
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? detail;
  } catch {
    /* plain text */
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 300);
  return `模型服务返回 ${status}${detail ? `：${detail}` : ''}`;
}

/** Sends one chat completion. Streams deltas when `onDelta` is given and returns the full text. */
export async function llmChat(cfg: LlmConfig, o: LlmChatOptions): Promise<string> {
  const url = chatUrl(cfg.baseUrl);
  if (!cfg.model.trim()) throw new Error('没有填写模型名');
  const stream = Boolean(o.onDelta);
  const body: Record<string, unknown> = {
    model: cfg.model.trim(),
    messages: [{ role: 'system', content: o.system }, ...o.messages],
    max_tokens: o.maxTokens ?? 4000,
    temperature: o.temperature ?? 0.2,
    stream,
  };
  if (o.jsonMode) body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;

  const signal = o.signal
    ? o.signal
    : o.timeoutMs
      ? AbortSignal.timeout(o.timeoutMs)
      : AbortSignal.timeout(120_000);

  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  // Some OpenAI-compatible servers reject response_format; retry once without it.
  if (!res.ok && o.jsonMode) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && /response_format|json_object|not support/i.test(text)) {
      delete body.response_format;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } else {
      throw new Error(errorText(res.status, text));
    }
  }
  if (!res.ok) throw new Error(errorText(res.status, await res.text().catch(() => '')));

  if (!stream) {
    const data = (await res.json()) as any;
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      (Array.isArray(data?.content) ? data.content.map((c: any) => c?.text ?? '').join('') : '');
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回内容');
    return content;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('模型流式响应不可读');
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      // Reasoning models stream their chain of thought in reasoning_content; the answer is content.
      const delta = j?.choices?.[0]?.delta?.content ?? '';
      if (typeof delta === 'string' && delta) {
        full += delta;
        o.onDelta?.(delta);
      }
    }
  }
  if (!full.trim()) throw new Error('模型没有返回内容');
  return full;
}

/** JSON answer → object. Strips code fences and grabs the outermost object/array like the desktop app. */
export function parseJsonLoose(answer: string): unknown {
  const text = answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('模型没有返回 JSON');
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(text.slice(start, end + 1));
}

export async function llmJson<T = unknown>(cfg: LlmConfig, system: string, payload: unknown, maxTokens = 8000, signal?: AbortSignal): Promise<T> {
  const raw = await llmChat(cfg, {
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    maxTokens,
    jsonMode: true,
    signal,
    timeoutMs: 180_000,
  });
  return parseJsonLoose(raw) as T;
}
