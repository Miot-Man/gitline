import { useEffect, useMemo, useState } from 'react';
import { X, History, ScanText } from 'lucide-react';
import type { Blame, FileLogEntry } from '../types';
import { git } from '../api';
import { authorColor, formatDate, relativeTime } from '../lib/format';
import { Avatar } from './ui';
import { DiffView } from './DiffView';
import { StatusIcon } from './RightPanel';

export type FileViewMode = 'history' | 'blame';

interface Props {
  repo: string;
  path: string;
  mode: FileViewMode;
  rev?: string; // blame at this commit instead of the working copy
  version: number;
  onMode: (m: FileViewMode) => void;
  onClose: () => void;
  onSelectSha: (sha: string) => void;
  onOpenInEditor: (line?: number) => void;
}

const UNCOMMITTED = '0'.repeat(40);
const noop = () => {};

export function FileHistory({ repo, path, mode, rev, version, onMode, onClose, onSelectSha, onOpenInEditor }: Props) {
  useEffect(() => {
    if (mode !== 'blame') return; // the history pane's DiffView handles Escape itself
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  return (
    <div className="file-view">
      <div className="diff-header">
        <span className="diff-path">{path}</span>
        {mode === 'blame' && rev && <span className="diff-badge">at {rev.slice(0, 7)}</span>}
        <span className="spacer" />
        <div className="seg">
          <button className={mode === 'history' ? 'on' : ''} onClick={() => onMode('history')} title="File history">
            <History size={14} /> History
          </button>
          <button className={mode === 'blame' ? 'on' : ''} onClick={() => onMode('blame')} title="Blame">
            <ScanText size={14} /> Blame
          </button>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={16} />
        </button>
      </div>
      {mode === 'history' ? (
        <HistoryPane repo={repo} path={path} version={version} onClose={onClose} />
      ) : (
        <BlamePane repo={repo} path={path} rev={rev} version={version} onSelectSha={onSelectSha} onOpenLine={onOpenInEditor} />
      )}
    </div>
  );
}

function HistoryPane({ repo, path, version, onClose }: { repo: string; path: string; version: number; onClose: () => void }) {
  const [entries, setEntries] = useState<FileLogEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    git<FileLogEntry[]>('fileLog', repo, path).then((e) => {
      if (!alive) return;
      setEntries(e);
      setSelected((s) => (s && e.some((x) => x.sha === s) ? s : e[0]?.sha ?? null));
    });
    return () => {
      alive = false;
    };
  }, [repo, path, version]);

  const entry = entries?.find((e) => e.sha === selected);
  const target = useMemo(
    () => (entry ? { kind: 'commit' as const, sha: entry.sha, parent: entry.parents[0], file: entry.file } : null),
    [entry]
  );

  if (!entries) return <div className="panel-empty">Loading…</div>;
  if (!entries.length) return <div className="panel-empty">No committed history for this file yet.</div>;

  return (
    <div className="file-view-body">
      <div className="history-list">
        {entries.map((e) => (
          <div key={e.sha} className={`history-item${e.sha === selected ? ' active' : ''}`} onClick={() => setSelected(e.sha)}>
            <Avatar name={e.author} color={authorColor(e.email)} size={24} />
            <div className="history-text">
              <div className="history-subject">{e.subject}</div>
              <div className="history-meta">
                <StatusIcon status={e.file.status} />
                {e.author} · <span title={formatDate(e.time)}>{relativeTime(e.time)}</span> · <code>{e.sha.slice(0, 7)}</code>
              </div>
              {e.file.oldPath && e.file.oldPath !== e.file.path && <div className="history-meta">renamed from {e.file.oldPath}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="history-diff">
        {target && (
          <DiffView
            repo={repo}
            target={target}
            version={version}
            onClose={onClose}
            onStageFile={noop}
            onUnstageFile={noop}
            onDiscardFile={noop}
            onApplyHunk={noop}
          />
        )}
      </div>
    </div>
  );
}

function BlamePane({
  repo,
  path,
  rev,
  version,
  onSelectSha,
  onOpenLine,
}: {
  repo: string;
  path: string;
  rev?: string;
  version: number;
  onSelectSha: (sha: string) => void;
  onOpenLine: (line: number) => void;
}) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    git<Blame>('blame', repo, path, rev)
      .then((b) => alive && setBlame(b))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, path, rev, version]);

  // Newer lines get a stronger age bar.
  const age = useMemo(() => {
    if (!blame) return () => 0;
    const times = Object.entries(blame.commits)
      .filter(([sha]) => sha !== UNCOMMITTED)
      .map(([, c]) => c.time);
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    return (t: number) => (hi === lo ? 1 : (t - lo) / (hi - lo));
  }, [blame]);

  if (error) return <div className="panel-empty">{error}</div>;
  if (!blame) return <div className="panel-empty">Loading…</div>;

  return (
    <div className="blame-body">
      <table className="blame-table">
        <tbody>
          {blame.lines.map((l, i) => {
            const c = blame.commits[l.sha];
            const first = i === 0 || blame.lines[i - 1].sha !== l.sha;
            const uncommitted = l.sha === UNCOMMITTED;
            return (
              <tr
                key={i}
                className={`${first ? 'blame-first' : ''}${hover === l.sha ? ' blame-hover' : ''}`}
                onMouseEnter={() => setHover(l.sha)}
                onDoubleClick={() => onOpenLine(i + 1)}
                title="Double-click to open this line in your editor"
              >
                <td
                  className="blame-gutter"
                  style={{ ['--age' as string]: uncommitted ? 1 : 0.15 + 0.85 * age(c.time) }}
                  onClick={() => !uncommitted && onSelectSha(l.sha)}
                  title={uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author} · ${formatDate(c.time)}\n${l.sha}`}
                >
                  {first &&
                    (uncommitted ? (
                      <span className="blame-info muted">Uncommitted changes</span>
                    ) : (
                      <span className="blame-info">
                        <code>{l.sha.slice(0, 7)}</code>
                        <span className="blame-author">{c.author}</span>
                        <span className="blame-date">{relativeTime(c.time)}</span>
                        <span className="blame-summary">{c.summary}</span>
                      </span>
                    ))}
                </td>
                <td className="ln">{i + 1}</td>
                <td className="code">{l.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
