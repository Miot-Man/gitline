import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Tag, Check, Search, X, ChevronUp, ChevronDown, Pencil, Plus, Minus, AlertTriangle } from 'lucide-react';
import type { Commit, Ref } from '../types';
import { WIP } from '../types';
import type { GraphRow } from '../lib/graph';
import { RESERVED, laneColor } from '../lib/graph';
import { authorColor, formatDate, initials } from '../lib/format';
import { refDragProps } from './Sidebar';

export const ROW_H = 34;
// Lanes are narrower than half a row, so a hop to the next lane fits a 45° diagonal.
const LANE_W = 16;
const R = 5;
const PAD = 10;
const MAX_TAGS = 2;

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
  onRefDrop: (e: React.DragEvent, sourceFull: string, target: Ref) => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
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

// Metro-map lane segment: a vertical run joined to a 45° diagonal when there's room for one.
// `diagonalFirst` leaves the start point diagonally (branching off); otherwise the diagonal arrives last (merging in).
function metro(x1: number, y1: number, x2: number, y2: number, diagonalFirst: boolean) {
  const dx = Math.abs(x2 - x1);
  if (dx === 0 || dx > y2 - y1) return `M${x1} ${y1}L${x2} ${y2}`;
  return diagonalFirst ? `M${x1} ${y1}L${x2} ${y1 + dx}V${y2}` : `M${x1} ${y1}V${y2 - dx}L${x2} ${y2}`;
}

const RowGraph = memo(function RowGraph({ item, width, isHead }: { item: GraphItem; width: number; isHead: boolean }) {
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
      paths.push(<path key={`t${k}`} d={metro(x(k), 0, x(col), mid, false)} stroke={inColor(k)} />);
    } else if (after[k] === sha) {
      paths.push(<path key={`p${k}`} d={`M${x(k)} 0L${x(k)} ${ROW_H}`} stroke={inColor(k)} />);
    }
  });
  parentCols.forEach((j, i) => {
    paths.push(
      <path
        key={`b${i}`}
        d={metro(x(col), mid, x(j), ROW_H, true)}
        stroke={outColor(j)}
        strokeDasharray={isWip ? '3 3' : undefined}
      />
    );
  });

  const isMerge = commit.parents.length > 1;
  const cx = x(col);
  return (
    <svg width={width} height={ROW_H} className="graph-svg">
      <g fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        {paths}
      </g>
      {isWip ? (
        <circle cx={cx} cy={mid} r={R} fill="var(--bg-graph)" stroke={color} strokeWidth={2} strokeDasharray="2.5 2" />
      ) : isHead ? (
        <g>
          <circle cx={cx} cy={mid} r={R + 3.5} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={2.5} />
          <circle cx={cx} cy={mid} r={R + 0.5} fill={color} />
        </g>
      ) : isMerge ? (
        <g>
          <circle cx={cx} cy={mid} r={R + 0.5} fill="var(--bg-graph)" stroke={color} strokeWidth={2.5} />
          <circle cx={cx} cy={mid} r={2} fill={color} />
        </g>
      ) : (
        <circle cx={cx} cy={mid} r={R} fill="var(--bg-graph)" stroke={color} strokeWidth={2.5} />
      )}
    </svg>
  );
});

export function CommitGraph(props: Props) {
  const { items, maxLanes, refsBySha, headSha, detached, selected, onSelect, scrollTarget, wip, findOpen, setFindOpen, compareSha } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
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
        <div className="col-graph" style={{ width: graphW }}>
          <RowGraph item={it} width={graphW} isHead={c.sha === headSha && !isWip} />
        </div>
        <div className="col-msg">
          {pills.slice(0, MAX_TAGS).map((p) => (
            <RefPill key={p.key} pill={p} color={color} onMenu={props.onRefMenu} onDouble={props.onRefDoubleClick} onDrop={props.onRefDrop} />
          ))}
          {pills.length > MAX_TAGS && (
            <span className="pill-more" title={pills.slice(MAX_TAGS).map((p) => p.label).join('\n')}>
              +{pills.length - MAX_TAGS}
            </span>
          )}
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
            <span className="msg-subject">{c.subject}</span>
          )}
        </div>
        <div className="col-author">
          {!isWip && (
            <>
              <span className="author-dot" style={{ background: authorColor(c.email) }}>
                {initials(c.author)}
              </span>
              <span className="row-author">{c.author}</span>
            </>
          )}
        </div>
        <div className="col-date">{isWip ? '' : formatDate(c.time)}</div>
        <div className="col-sha">{isWip ? '' : c.sha.slice(0, 7)}</div>
      </div>
    );
  }

  return (
    <div className="graph">
      <div className="graph-header">
        <div className="col-graph" style={{ width: graphW }}>
          Graph
        </div>
        <div className="col-msg">Commit</div>
        <div className="col-author">Author</div>
        <div className="col-date">Date</div>
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
        <div style={{ height: items.length * ROW_H + (props.canLoadMore ? ROW_H * 2 : 0), position: 'relative' }}>
          {rows}
          {props.canLoadMore && (
            <div className="load-more" style={{ top: items.length * ROW_H }}>
              <button className="btn btn-sm" onClick={props.onLoadMore}>
                Load more commits
              </button>
            </div>
          )}
        </div>
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
  onDrop,
}: {
  pill: Pill;
  color: string;
  onMenu: (e: React.MouseEvent, r: Ref) => void;
  onDouble: (r: Ref) => void;
  onDrop: (e: React.DragEvent, sourceFull: string, target: Ref) => void;
}) {
  const primary = pill.local ?? pill.tag ?? pill.remotes[0];
  const drag = primary ? refDragProps(primary, onDrop) : {};
  return (
    <span
      className={`ref-pill${pill.isHead ? ' head' : ''}${pill.tag ? ' tag' : ''}`}
      style={{ ['--tag' as string]: color }}
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
      {...drag}
    >
      {pill.isHead && pill.local && <Check size={11} className="pill-check" />}
      {pill.tag && <Tag size={11} className="pill-icon" />}
      <span className="pill-label">{pill.label}</span>
      {pill.local && pill.remotes.length > 0 && <Cloud size={11} className="pill-icon" />}
    </span>
  );
}
