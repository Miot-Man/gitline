import { useEffect, useMemo, useState } from 'react';
import { X, Columns2, Rows3 } from 'lucide-react';
import type { DiffTarget } from '../types';
import { git } from '../api';
import { parseDiff, type DiffLine, type Hunk } from '../lib/diff';
import { StatusIcon } from './RightPanel';

interface Props {
  repo: string;
  target: DiffTarget;
  version: number;
  onClose: () => void;
  onStageFile: () => void;
  onUnstageFile: () => void;
  onDiscardFile: () => void;
  onApplyHunk: (patch: string, cached: boolean, reverse: boolean) => void;
}

const MAX_LINES = 20000;

export function DiffView({ repo, target, version, onClose, onStageFile, onUnstageFile, onDiscardFile, onApplyHunk }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(() => localStorage.getItem('diffSplit') === '1');
  const file = target.file;

  useEffect(() => {
    let alive = true;
    setError(null);
    const p =
      target.kind === 'wip'
        ? git<string>('diffWorking', repo, file.path, target.staged, file.status === '?', target.staged ? file.oldPath : undefined)
        : git<string>('diffCommit', repo, target.sha, file.path, file.oldPath, target.parent);
    p.then((t) => alive && setText(t)).catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, target, version, file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = useMemo(() => (text === null ? null : parseDiff(text)), [text]);
  const isWip = target.kind === 'wip';
  const staged = isWip && target.staged;
  const untracked = file.status === '?';
  const hunkActions = isWip && !untracked && file.status !== 'U' && parsed && !parsed.combined && !parsed.binary;
  const totalLines = parsed ? parsed.hunks.reduce((n, h) => n + h.lines.length, 0) : 0;

  const toggleSplit = () => {
    setSplit((s) => {
      localStorage.setItem('diffSplit', s ? '0' : '1');
      return !s;
    });
  };

  return (
    <div className="diff-view">
      <div className="diff-header">
        <StatusIcon status={file.status} />
        <span className="diff-path">
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        {isWip && <span className={`diff-badge ${staged ? 'staged' : 'unstaged'}`}>{staged ? 'Staged' : 'Unstaged'}</span>}
        <span className="spacer" />
        <div className="seg">
          <button className={!split ? 'on' : ''} onClick={() => split && toggleSplit()} title="Unified">
            <Rows3 size={14} />
          </button>
          <button className={split ? 'on' : ''} onClick={() => !split && toggleSplit()} title="Split">
            <Columns2 size={14} />
          </button>
        </div>
        {isWip && !staged && file.status !== 'U' && (
          <button className="btn btn-sm btn-danger-ghost" onClick={onDiscardFile}>
            Discard File
          </button>
        )}
        {isWip && !staged && (
          <button className="btn btn-sm btn-stage" onClick={onStageFile}>
            {file.status === 'U' ? 'Mark Resolved' : 'Stage File'}
          </button>
        )}
        {isWip && staged && (
          <button className="btn btn-sm btn-unstage" onClick={onUnstageFile}>
            Unstage File
          </button>
        )}
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={16} />
        </button>
      </div>
      <div className="diff-body">
        {error && <div className="diff-message">{error}</div>}
        {!error && parsed === null && <div className="diff-message">Loading…</div>}
        {parsed && parsed.binary && <div className="diff-message">Binary file — no text diff available.</div>}
        {parsed && !parsed.binary && parsed.hunks.length === 0 && (
          <div className="diff-message">{text?.trim() ? <pre>{text}</pre> : 'No changes (file mode change or empty file).'}</div>
        )}
        {parsed && totalLines > MAX_LINES && <div className="diff-message">Diff is very large; showing the first {MAX_LINES.toLocaleString()} lines.</div>}
        {parsed &&
          !parsed.binary &&
          limitHunks(parsed.hunks).map((h, i) => (
            <div className="hunk" key={i}>
              <div className="hunk-header">
                <code>{h.header}</code>
                {hunkActions && (
                  <span className="hunk-actions">
                    {!staged && (
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => onApplyHunk(parsed.header + h.raw, false, true)}>
                        Discard Hunk
                      </button>
                    )}
                    {!staged ? (
                      <button className="btn btn-xs btn-stage" onClick={() => onApplyHunk(parsed.header + h.raw, true, false)}>
                        Stage Hunk
                      </button>
                    ) : (
                      <button className="btn btn-xs btn-unstage" onClick={() => onApplyHunk(parsed.header + h.raw, true, true)}>
                        Unstage Hunk
                      </button>
                    )}
                  </span>
                )}
              </div>
              {split ? <SplitHunk lines={h.lines} /> : <UnifiedHunk lines={h.lines} />}
            </div>
          ))}
      </div>
    </div>
  );
}

function limitHunks(hunks: Hunk[]) {
  let n = 0;
  const out: Hunk[] = [];
  for (const h of hunks) {
    if (n >= MAX_LINES) break;
    out.push(n + h.lines.length > MAX_LINES ? { ...h, lines: h.lines.slice(0, MAX_LINES - n) } : h);
    n += h.lines.length;
  }
  return out;
}

const sign = (t: DiffLine['type']) => (t === 'add' ? '+' : t === 'del' ? '-' : ' ');

function UnifiedHunk({ lines }: { lines: DiffLine[] }) {
  return (
    <table className="diff-table">
      <tbody>
        {lines.map((l, i) =>
          l.type === 'meta' ? (
            <tr key={i} className="dl-meta">
              <td className="ln" />
              <td className="ln" />
              <td className="code">{l.text}</td>
            </tr>
          ) : (
            <tr key={i} className={`dl-${l.type}`}>
              <td className="ln">{l.oldNo ?? ''}</td>
              <td className="ln">{l.newNo ?? ''}</td>
              <td className="code">
                <span className="sign">{sign(l.type)}</span>
                {l.text}
              </td>
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

function SplitHunk({ lines }: { lines: DiffLine[] }) {
  const rows: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx' || l.type === 'meta') {
      rows.push([l, l]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  const cell = (l: DiffLine | null, side: 'old' | 'new') => {
    if (!l) return [<td key="n" className="ln empty" />, <td key="c" className="code empty" />];
    const cls = l.type === 'meta' ? 'dl-meta' : `dl-${l.type}`;
    return [
      <td key="n" className={`ln ${cls}`}>
        {side === 'old' ? l.oldNo ?? '' : l.newNo ?? ''}
      </td>,
      <td key="c" className={`code ${cls}`}>
        {l.type !== 'meta' && <span className="sign">{sign(l.type)}</span>}
        {l.text}
      </td>,
    ];
  };
  return (
    <table className="diff-table split">
      <tbody>
        {rows.map(([a, b], k) => (
          <tr key={k}>
            {cell(a, 'old')}
            {cell(b, 'new')}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
