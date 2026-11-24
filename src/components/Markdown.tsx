/** Tiny safe Markdown renderer: headings, lists, quotes, code, bold, links, and clickable
 *  [mm:ss] / [mm:ss]-[mm:ss] timestamps. No HTML injection; every piece goes through React text. */
import { Fragment, type ReactNode } from 'react';
import { parseClock } from '../lib/captions';

interface Props {
  text: string;
  onSeek?: (seconds: number) => void;
  /** Compact spacing for chat answers. */
  dense?: boolean;
}

const TS = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\s*[-–—]\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\])?/g;
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:[^)\s]+\)|\[(?:\d{1,2}:\d{2}(?::\d{2})?)\](?:\s*[-–—]\s*\[(?:\d{1,2}:\d{2}(?::\d{2})?)\])?)/g;

function inline(text: string, onSeek?: (s: number) => void, k = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index == null) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${k}-${i++}`;
    if (token.startsWith('**')) {
      out.push(<strong key={key}>{inline(token.slice(2, -2), onSeek, key)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[') && token.includes('](')) {
      const mm = token.match(/^\[([^\]]+)\]\((https?:[^)\s]+)\)$/);
      out.push(
        mm ? (
          <a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>
        ) : (
          token
        ),
      );
    } else {
      const mm = token.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\s*[-–—]\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\])?$/) ?? token.match(TS);
      if (mm) {
        const start = parseClock(mm[1]);
        const label = mm[2] ? `${mm[1]}–${mm[2]}` : mm[1];
        out.push(
          <button key={key} className="ts" type="button" title="跳到这一句" onClick={() => onSeek?.(start)}>
            {label}
          </button>,
        );
      } else {
        out.push(token);
      }
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Blocks({ text, onSeek }: Props): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={`p${key++}`}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], onSeek, `h${key}`);
      blocks.push(
        level <= 2 ? (
          <h2 key={`h${key++}`}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={`h${key++}`}>{content}</h3>
        ) : (
          <h4 key={`h${key++}`}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`r${key++}`} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={`q${key++}`}>
          {buf.map((b, j) => (
            <p key={j}>{inline(b, onSeek, `q${key}-${j}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      blocks.push(
        <ul key={`u${key++}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, onSeek, `u${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push(
        <ol key={`o${key++}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, onSeek, `o${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*([-*_])\1{2,}\s*$)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={`t${key++}`}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, onSeek, `t${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <>{blocks}</>;
}

export default function Markdown({ text, onSeek, dense }: Props) {
  return <div className={`md ${dense ? 'md-dense' : ''}`}><Blocks text={text} onSeek={onSeek} /></div>;
}
