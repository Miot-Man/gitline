import { shortcut } from '../lib/settings';
import { useState } from 'react';
import { ArrowUp, ArrowDown, CornerRightDown } from 'lucide-react';
import type { RebaseAction, RebaseCommit } from '../types';
import { authorColor, relativeTime } from '../lib/format';
import { Avatar } from './ui';

export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  message?: string;
}

interface Props {
  branch: string;
  base: string;
  commits: RebaseCommit[]; // oldest first, as git replays them
  onCancel: () => void;
  onStart: (steps: RebaseStep[]) => void; // oldest first
}

interface Row {
  commit: RebaseCommit;
  action: RebaseAction;
  message: string;
}

const ALT = /Mac/.test(navigator.platform) ? '⌥' : 'Alt+';

const ACTIONS: { action: RebaseAction; key: string; label: string; title: string }[] = [
  { action: 'pick', key: 'p', label: 'Pick', title: 'Keep this commit' },
  { action: 'reword', key: 'r', label: 'Reword', title: 'Keep the commit but edit its message' },
  { action: 'squash', key: 's', label: 'Squash', title: 'Combine into the commit below, keeping both messages' },
  { action: 'fixup', key: 'f', label: 'Fixup', title: 'Combine into the commit below, discarding this message' },
  { action: 'drop', key: 'd', label: 'Drop', title: 'Remove this commit' },
];

export function InteractiveRebase({ branch, base, commits, onCancel, onStart }: Props) {
  // Displayed newest first, like the graph; reversed back when starting.
  const [rows, setRows] = useState<Row[]>(() => [...commits].reverse().map((c) => ({ commit: c, action: 'pick', message: c.message })));
  const [focus, setFocus] = useState(0);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    setRows((rs) => {
      const next = rs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setFocus(j);
  };

  const oldestFirst = [...rows].reverse();
  const kept = oldestFirst.filter((r) => r.action !== 'drop');
  const unchanged = rows.every((r, i) => r.action === 'pick' && r.commit.sha === commits[commits.length - 1 - i].sha);
  let problem: string | null = null;
  if (!kept.length) problem = 'Every commit is dropped. To discard them all, reset to the base commit instead.';
  else if (kept[0].action === 'squash' || kept[0].action === 'fixup') problem = 'The bottom commit has nothing below it to squash into.';
  else if (rows.some((r) => r.action === 'reword' && !r.message.trim())) problem = 'Reworded commits need a message.';

  const start = () => {
    if (problem || unchanged) return;
    onStart(oldestFirst.map((r) => ({ sha: r.commit.sha, action: r.action, ...(r.action === 'reword' ? { message: r.message } : {}) })));
  };

  const onRowKey = (e: React.KeyboardEvent, i: number) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) move(i, e.key === 'ArrowUp' ? -1 : 1);
    else if (e.key === 'ArrowUp') setFocus(Math.max(0, i - 1));
    else if (e.key === 'ArrowDown') setFocus(Math.min(rows.length - 1, i + 1));
    else {
      const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
      if (!a || e.metaKey || e.ctrlKey) return;
      set(i, { action: a.action });
    }
    e.preventDefault();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal rebase-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
        }}
      >
        <div className="modal-title">
          Interactive rebase <b>{branch}</b> onto <code>{base.slice(0, 7)}</code>
        </div>
        <div className="rebase-help">
          Newest commit at the top. Keys: <kbd>P</kbd>ick <kbd>R</kbd>eword <kbd>S</kbd>quash <kbd>F</kbd>ixup <kbd>D</kbd>rop, <kbd>{ALT}↑</kbd>/<kbd>{ALT}↓</kbd> to
          move.
        </div>
        <div className="rebase-list">
          {rows.map((r, i) => {
            const [subject] = r.commit.message.split('\n');
            const merging = r.action === 'squash' || r.action === 'fixup';
            return (
              <div
                key={r.commit.sha}
                className={`rebase-row action-${r.action}`}
                tabIndex={0}
                ref={(el) => {
                  if (el && i === focus && document.activeElement !== el && !(document.activeElement instanceof HTMLTextAreaElement)) el.focus();
                }}
                onFocus={() => setFocus(i)}
                onKeyDown={(e) => onRowKey(e, i)}
              >
                <div className="rebase-main">
                  <div className="rebase-move">
                    <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up (newer)">
                      <ArrowUp size={13} />
                    </button>
                    <button className="icon-btn" disabled={i === rows.length - 1} onClick={() => move(i, 1)} title="Move down (older)">
                      <ArrowDown size={13} />
                    </button>
                  </div>
                  <div className="seg rebase-actions">
                    {ACTIONS.map((a) => (
                      <button key={a.action} className={r.action === a.action ? 'on' : ''} title={a.title} onClick={() => set(i, { action: a.action })}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <Avatar name={r.commit.author} color={authorColor(r.commit.email)} size={20} />
                  <span className="rebase-subject" title={r.commit.message}>
                    {merging && <CornerRightDown size={12} className="rebase-into" />}
                    {subject}
                  </span>
                  <span className="muted">{relativeTime(r.commit.time)}</span>
                  <code className="muted">{r.commit.sha.slice(0, 7)}</code>
                </div>
                {r.action === 'reword' && (
                  <textarea className="rebase-message" rows={3} value={r.message} onChange={(e) => set(i, { message: e.target.value })} />
                )}
              </div>
            );
          })}
        </div>
        {problem && <div className="rebase-problem">{problem}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!problem || unchanged} onClick={start} title={shortcut('Enter')}>
            Start Rebase
          </button>
        </div>
      </div>
    </div>
  );
}
