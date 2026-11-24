import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { activeIndex, clock } from '../../src/lib/captions';
import type { DisplayMode, Segment } from '../../src/lib/types';

interface Props {
  segments: Segment[];
  items: (string | null)[] | null;
  mode: DisplayMode;
  time: number;
  follow: boolean;
  translating: boolean;
  onSeek: (seconds: number) => void;
  onFollowChange: (follow: boolean) => void;
}

let clickTimer: number | undefined;
let downAt: { x: number; y: number } | null = null;

function selectable() {
  return Boolean(window.getSelection()?.toString().trim());
}

const Row = memo(function Row({
  index,
  seg,
  zh,
  mode,
  active,
  translating,
  onSeek,
  register,
}: {
  index: number;
  seg: Segment;
  zh: string | null;
  mode: DisplayMode;
  active: boolean;
  translating: boolean;
  onSeek: (seconds: number) => void;
  register: (i: number, el: HTMLDivElement | null) => void;
}) {
  const showZh = mode !== 'original' && Boolean(zh);
  const showOrig = mode !== 'zh' || !zh;
  const click = (e: React.MouseEvent) => {
    window.clearTimeout(clickTimer);
    const dragged = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (e.detail > 1 || dragged || selectable()) return;
    clickTimer = window.setTimeout(() => {
      if (!selectable()) onSeek(seg.start);
    }, 220);
  };
  return (
    <div
      ref={(el) => register(index, el)}
      className={`sub-row${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={click}
      onPointerDown={(e) => {
        downAt = { x: e.clientX, y: e.clientY };
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSeek(seg.start);
      }}
    >
      <button
        type="button"
        className="sub-time"
        title="跳到这一句"
        onClick={(e) => {
          e.stopPropagation();
          onSeek(seg.start);
        }}
      >
        {clock(seg.start)}
      </button>
      <div className="sub-texts">
        {showOrig && <div className="sub-orig">{seg.text}</div>}
        {showZh && <div className="sub-zh">{zh}</div>}
        {mode === 'zh' && !zh && translating && <span className="sub-pending" title="翻译中" />}
      </div>
    </div>
  );
});

export default function SubtitleList({ segments, items, mode, time, follow, translating, onSeek, onFollowChange }: Props) {
  const active = useMemo(() => activeIndex(segments, time), [segments, time]);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const programmatic = useRef(false);
  const container = useRef<HTMLDivElement | null>(null);

  const register = useCallback((i: number, el: HTMLDivElement | null) => {
    if (el) rows.current.set(i, el);
    else rows.current.delete(i);
  }, []);

  useEffect(() => {
    if (!follow || active < 0) return;
    const el = rows.current.get(active);
    if (!el) return;
    programmatic.current = true;
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    const t = setTimeout(() => {
      programmatic.current = false;
    }, 120);
    return () => clearTimeout(t);
  }, [active, follow]);

  if (!segments.length) return null;

  return (
    <div
      className="subs"
      ref={container}
      onWheel={() => {
        if (!programmatic.current) onFollowChange(false);
      }}
      onTouchMove={() => {
        if (!programmatic.current) onFollowChange(false);
      }}
    >
      {segments.map((seg, i) => (
        <Row
          key={i}
          index={i}
          seg={seg}
          zh={items?.[i] ?? null}
          mode={mode}
          active={i === active}
          translating={translating}
          onSeek={onSeek}
          register={register}
        />
      ))}
      <div className="subs-tail" />
    </div>
  );
}
