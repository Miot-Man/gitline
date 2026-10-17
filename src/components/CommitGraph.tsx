import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Laptop, Cloud, Tag, Check, Search, X, ChevronUp, ChevronDown, Pencil, Plus, Minus, AlertTriangle } from 'lucide-react';
import type { Commit, Ref } from '../types';
import { WIP } from '../types';
import type { GraphRow } from '../lib/graph';
import { RESERVED, laneColor } from '../lib/graph';
import { formatDate, initials } from '../lib/format';

export const ROW_H = 32;
const LANE_W = 24;
const R = 11;
const PAD = 8;

export interface GraphItem {
  commit: Commit;
  graph: GraphRow;
}

interface Pill {
  key: string;
  label: string;
  local?: Ref;
  remotes: Ref[];
  tag?: Ref;
  isHead: boolean;
}

export interface WipCounts {
  modified: number;
  added: number;
  deleted: number;
  conflicted: number;
}

interface Props {
  items: GraphItem[];
  maxLanes: number;
  refsBySha: Map<string, Ref[]>;
  headSha: string | null;
  detached: boolean;
  selected: string | null;
  onSelect: (sha: string) => void;
  onRowMenu: (e: React.MouseEvent, c: Commit) => void;
  onRefMenu: (e: React.MouseEvent, r: Ref) => void;
  onRefDoubleClick: (r: Ref) => void;
  scrollTarget: { sha: string; n: number } | null;
  wip: WipCounts;
  findOpen: boolean;
  setFindOpen: (v: boolean) => void;
  compareSha: string | null;
  onCompare: (sha: string) => void;
  onSearch: (mode: Exclude<SearchMode, 'message'>, query: string) => Promise<string[]>;
  filterNote: React.ReactNode;
}

export type SearchMode = 'message' | 'changes' | 'path';

const SEARCH_MODES: { mode: SearchMode; label: string; placeholder: string }[] = [
  { mode: 'message', label: 'Message', placeholder: 'Search message, sha, author' },
  { mode: 'changes', label: 'Changes', placeholder: 'Search added/removed code (regex)' },
  { mode: 'path', label: 'File', placeholder: 'Search changed file names' },
];

function buildPills(refs: Ref[], isHeadCommit: boolean, detached: boolean): Pill[] {
  const pills: Pill[] = [];
  const remotes = refs.filter((r) => r.type === 'remote');
  const used = new Set<Ref>();
  for (const l of refs.filter((r) => r.type === 'local')) {
    const matching = remotes.filter((r) => r.name.slice(r.name.indexOf('/') + 1) === l.name);
    matching.forEach((m) => used.add(m));
    pills.push({ key: l.full, label: l.name, local: l, remotes: matching, isHead: l.isHead });
  }
  for (const r of remotes) if (!used.has(r)) pills.push({ key: r.full, label: r.name, remotes: [r], isHead: false });
  for (const t of refs.filter((r) => r.type === 'tag')) pills.push({ key: t.full, label: t.name, remotes: [], tag: t, isHead: false });
  if (isHeadCommit && detached) pills.unshift({ key: 'HEAD', label: 'HEAD', remotes: [], isHead: true });
  pills.sort((a, b) => Number(b.isHead) - Number(a.isHead));
  return pills;
}

const x = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;

function curve(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

const RowGraph = memo(function RowGraph({
  item,
  width,
  hasRefs,
}: {
  item: GraphItem;
  width: number;
  hasRefs: boolean;
}) {
  const { commit, graph } = item;
  const { col, before, after, parentCols, beforeColors, afterColors } = graph;
  const mid = ROW_H / 2;
  const isWip = commit.sha === WIP;
  const color = laneColor(afterColors[col] ?? beforeColors[col] ?? col);
  // A lane merging in keeps its own color; lanes leaving take the color of where they continue.
  const inColor = (k: number) => laneColor(beforeColors[k] ?? k);
  const outColor = (k: number) => laneColor(afterColors[k] ?? k);
  const paths: React.ReactElement[] = [];

  before.forEach((sha, k) => {
    if (sha === null || sha === RESERVED) return;
    if (sha === commit.sha) {
      paths.push(<path key={`t${k}`} d={curve(x(k), 0, x(col), mid)} stroke={inColor(k)} />);
    } else if (after[k] === sha) {
      paths.push(<path key={`p${k}`} d={`M${x(k)} 0L${x(k)} ${ROW_H}`} stroke={inColor(k)} />);
    }
  });
  parentCols.forEach((j, i) => {
    paths.push(
      <path
        key={`b${i}`}
        d={curve(x(col), mid, x(j), ROW_H)}
        stroke={outColor(j)}
        strokeDasharray={isWip ? '3 3' : undefined}
      />
    );
  });

  const isMerge = commit.parents.length > 1;
  return (
    <svg width={width} height={ROW_H} className="graph-svg">
      {hasRefs && <line x1={0} y1={mid} x2={x(col)} y2={mid} stroke={color} strokeWidth={2} opacity={0.7} />}
      <g fill="none" strokeWidth={2}>
        {paths}
      </g>
      {isWip ? (
        <circle cx={x(col)} cy={mid} r={R - 1} fill="var(--bg-graph)" stroke={color} strokeWidth={2} strokeDasharray="3 2" />
      ) : isMerge ? (
        <circle cx={x(col)} cy={mid} r={5} fill={color} />
      ) : (
        <g>
          <circle cx={x(col)} cy={mid} r={R} fill={color} />
          <circle cx={x(col)} cy={mid} r={R - 2} fill="var(--bg-avatar)" />
          <text x={x(col)} y={mid + 3.5} textAnchor="middle" className="avatar-text">
            {initials(commit.author)}
          </text>
        </g>
      )}
    </svg>
  );
});

export function CommitGraph(props: Props) {
  const { items, maxLanes, refsBySha, headSha, detached, selected, onSelect, scrollTarget, wip, findOpen, setFindOpen, compareSha } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const [refW, setRefW] = useState(200);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('message');
  const [serverHits, setServerHits] = useState<{ key: string; shas: Set<string> } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);

  const graphW = Math.min(Math.max(maxLanes * LANE_W + PAD * 2, 60), 420);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => m.set(it.commit.sha, i));
    return m;
  }, [items]);

  const ensureVisible = (i: number, center = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = i * ROW_H;
    if (center) el.scrollTop = top - el.clientHeight / 2 + ROW_H / 2;
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  useEffect(() => {
    if (!scrollTarget) return;
    const i = indexOf.get(scrollTarget.sha);
    if (i !== undefined) ensureVisible(i, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);

  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const q = query.trim().toLowerCase();
  const serverKey = `${mode}\0${query.trim()}`;

  // Diff and path searches run in git, debounced.
  const { onSearch } = props;
  useEffect(() => {
    setSearchError(null);
    if (mode === 'message' || !q) return setServerHits(null);
    const t = setTimeout(() => {
      onSearch(mode, query.trim())
        .then((shas) => setServerHits({ key: serverKey, shas: new Set(shas) }))
        .catch((e) => setSearchError(e.message));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const searching = mode !== 'message' && !!q && serverHits?.key !== serverKey && !searchError;
  const matches = useMemo(() => {
    if (!q) return [] as number[];
    const out: number[] = [];
    items.forEach((it, i) => {
      const c = it.commit;
      if (c.sha === WIP) return;
      if (mode !== 'message') {
        if (serverHits?.key === serverKey && serverHits.shas.has(c.sha)) out.push(i);
      } else if (c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
        out.push(i);
    });
    return out;
  }, [items, q, mode, serverHits, serverKey]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const jump = (dir: 1 | -1) => {
    if (!matches.length) return;
    const cur = selected ? indexOf.get(selected) ?? -1 : -1;
    let target = dir === 1 ? matches.find((m) => m > cur) : [...matches].reverse().find((m) => m < cur);
    if (target === undefined) target = dir === 1 ? matches[0] : matches[matches.length - 1];
    onSelect(items[target].commit.sha);
    ensureVisible(target, true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const cur = selected ? indexOf.get(selected) ?? -1 : -1;
    const next = Math.max(0, Math.min(items.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    if (items[next]) {
      onSelect(items[next].commit.sha);
      ensureVisible(next);
    }
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);

  const onRefResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = refW;
    const move = (ev: MouseEvent) => setRefW(Math.max(90, Math.min(500, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const rows: React.ReactElement[] = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    const c = it.commit;
    const isWip = c.sha === WIP;
    const color = laneColor(it.graph.afterColors[it.graph.col] ?? it.graph.beforeColors[it.graph.col] ?? it.graph.col);
    const pills = isWip ? [] : buildPills(refsBySha.get(c.sha) ?? [], c.sha === headSha, detached);
    const isSel = selected === c.sha;
    // Both ends of a comparison get the compare marker.
    const isCmp = !!compareSha && (compareSha === c.sha || isSel);
    const dim = q && !searching && !isWip && !matchSet.has(i);
    rows.push(
      <div
        key={c.sha}
        className={`graph-row${isSel ? ' selected' : ''}${isCmp ? ' compare' : ''}${dim ? ' dim' : ''}${matchSet.has(i) ? ' match' : ''}`}
        style={{ top: i * ROW_H, ['--lane' as string]: color }}
        onMouseDown={(e) => {
          if (e.button !== 0 && (isSel || isCmp)) return; // keep a comparison when right-clicking either side
          if ((e.metaKey || e.ctrlKey) && e.button === 0 && !isWip) props.onCompare(c.sha);
          else onSelect(c.sha);
        }}
        onContextMenu={(e) => props.onRowMenu(e, c)}
      >
        <div className="col-refs" style={{ width: refW }}>
          {pills.length > 0 && (
            <>
              <RefPill pill={pills[0]} color={color} onMenu={props.onRefMenu} onDouble={props.onRefDoubleClick} />
              {pills.length > 1 && (
                <span className="pill-more" style={{ borderColor: color }} title={pills.slice(1).map((p) => p.label).join('\n')}>
                  +{pills.length - 1}
                </span>
              )}
              <span className="ref-line" style={{ borderColor: color }} />
            </>
          )}
        </div>
        <div className="col-graph" style={{ width: graphW }}>
          <RowGraph item={it} width={graphW} hasRefs={pills.length > 0} />
        </div>
        <div className="col-msg">
          {isWip ? (
            <span className="wip-msg">
              <span className="wip-label">// WIP</span>
              {wip.conflicted > 0 && (
                <span className="wip-count conflict">
                  <AlertTriangle size={11} /> {wip.conflicted}
                </span>
              )}
              {wip.modified > 0 && (
                <span className="wip-count mod">
                  <Pencil size={11} /> {wip.modified}
                </span>
              )}
              {wip.added > 0 && (
                <span className="wip-count add">
                  <Plus size={11} /> {wip.added}
                </span>
              )}
              {wip.deleted > 0 && (
                <span className="wip-count del">
                  <Minus size={11} /> {wip.deleted}
                </span>
              )}
            </span>
          ) : (
            c.subject
          )}
        </div>
        <div className="col-author">{isWip ? '' : c.author}</div>
        <div className="col-date">{isWip ? '' : formatDate(c.time)}</div>
        <div className="col-sha">{isWip ? '' : c.sha.slice(0, 7)}</div>
      </div>
    );
  }

  return (
    <div className="graph">
      <div className="graph-header">
        <div className="col-refs" style={{ width: refW }}>
          BRANCH / TAG
          <span className="col-resize" onMouseDown={onRefResize} />
        </div>
        <div className="col-graph" style={{ width: graphW }}>
          GRAPH
        </div>
        <div className="col-msg">COMMIT MESSAGE</div>
        <div className="col-author">AUTHOR</div>
        <div className="col-date">DATE</div>
        <div className="col-sha">SHA</div>
        {findOpen && (
          <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
            <Search size={13} />
            <div className="seg find-modes">
              {SEARCH_MODES.map((m) => (
                <button
                  key={m.mode}
                  className={mode === m.mode ? 'on' : ''}
                  onClick={() => {
                    setMode(m.mode);
                    findRef.current?.focus();
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <input
              ref={findRef}
              value={query}
              placeholder={SEARCH_MODES.find((m) => m.mode === mode)!.placeholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') {
                  setQuery('');
                  setFindOpen(false);
                }
              }}
            />
            <span className={`find-count${searchError ? ' error' : ''}`} title={searchError ?? undefined}>
              {searchError ? 'error' : searching ? '…' : q ? `${matches.length}` : ''}
            </span>
            <button className="icon-btn" onClick={() => jump(-1)}>
              <ChevronUp size={14} />
            </button>
            <button className="icon-btn" onClick={() => jump(1)}>
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setQuery('');
                setFindOpen(false);
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {props.filterNote && <div className="graph-filter-note">{props.filterNote}</div>}
      <div className="graph-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: items.length * ROW_H, position: 'relative' }}>{rows}</div>
        {items.length === 0 && <div className="empty-graph">No commits yet. Stage some files and make your first commit.</div>}
      </div>
    </div>
  );
}

function RefPill({
  pill,
  color,
  onMenu,
  onDouble,
}: {
  pill: Pill;
  color: string;
  onMenu: (e: React.MouseEvent, r: Ref) => void;
  onDouble: (r: Ref) => void;
}) {
  const primary = pill.local ?? pill.tag ?? pill.remotes[0];
  return (
    <span
      className={`ref-pill${pill.isHead ? ' head' : ''}`}
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 28%, var(--bg-graph))` }}
      title={[pill.local && `Local: ${pill.local.name}`, ...pill.remotes.map((r) => `Remote: ${r.name}`), pill.tag && `Tag: ${pill.tag.name}`]
        .filter(Boolean)
        .join('\n')}
      onContextMenu={(e) => {
        if (!primary) return;
        e.stopPropagation();
        onMenu(e, primary);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (primary) onDouble(primary);
      }}
    >
      {pill.isHead && pill.local && <Check size={12} className="pill-check" />}
      <span className="pill-label">{pill.label}</span>
      {pill.local && <Laptop size={12} className="pill-icon" />}
      {pill.remotes.length > 0 && <Cloud size={12} className="pill-icon" />}
      {pill.tag && <Tag size={12} className="pill-icon" />}
    </span>
  );
}
