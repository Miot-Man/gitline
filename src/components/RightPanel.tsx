import { shortcut } from '../lib/settings';
import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Minus, ArrowRight, Copy as CopyIcon, AlertTriangle, Trash2, FileQuestion, GitCommitHorizontal, X, ArrowUpDown, Users, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import type { Author, Commit, CommitDetails, FileChange, RepoInfo, Stash, Status } from '../types';
import { git } from '../api';
import { authorColor, formatDate, relativeTime, splitPath } from '../lib/format';
import { isDeletion, kindLabel, type Sides } from '../lib/conflicts';
import { Avatar } from './ui';

export function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'A':
    case '?':
      return <Plus size={13} className="st st-add" />;
    case 'D':
      return <Minus size={13} className="st st-del" />;
    case 'R':
    case 'C':
      return <ArrowRight size={13} className="st st-ren" />;
    case 'U':
      return <AlertTriangle size={13} className="st st-conf" />;
    default:
      return <Pencil size={13} className="st st-mod" />;
  }
}

// While one of a list's diffs is open, ↑/↓ open the previous / next file in that list.
function useFileStepper(files: FileChange[], activePath: string | null, open: (f: FileChange) => void) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!activePath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
      const i = files.findIndex((f) => f.path === activePath);
      const next = i < 0 ? undefined : files[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      openRef.current(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files, activePath]);
}

function FileRow({
  file,
  active,
  onClick,
  onContextMenu,
  action,
  note,
}: {
  file: FileChange;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  action?: React.ReactNode;
  note?: string;
}) {
  const { dir, name } = splitPath(file.path);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div ref={ref} className={`file-row${active ? ' active' : ''}`} onClick={onClick} onContextMenu={onContextMenu} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
      <StatusIcon status={file.status} />
      <span className="file-path">
        <span className="file-dir">{dir}</span>
        <span className="file-name">{name}</span>
      </span>
      {note && <span className="file-kind">{note}</span>}
      {action && (
        <span className="file-action" onClick={(e) => e.stopPropagation()}>
          {action}
        </span>
      )}
    </div>
  );
}

interface StagingProps {
  repo: string;
  status: Status;
  info: RepoInfo;
  summary: string;
  setSummary: (s: string) => void;
  description: string;
  setDescription: (s: string) => void;
  amend: boolean;
  setAmend: (b: boolean) => void;
  activePath: string | null;
  activeStaged: boolean | null;
  onOpenDiff: (f: FileChange, staged: boolean) => void;
  onStage: (files: FileChange[]) => void;
  onUnstage: (files: FileChange[]) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
  onFileMenu: (e: React.MouseEvent, f: FileChange, staged: boolean) => void;
  onCommit: () => void;
  sides: Sides;
  stashConflict: { ref: string; pop: boolean } | null; // a stash apply / pop that stopped on conflicts
  onResolve: (f: FileChange, side: 'ours' | 'theirs') => void;
  onMarkResolved: (f: FileChange) => void;
  onKeep: (f: FileChange) => void;
  onDelete: (f: FileChange) => void;
  onAbort: () => void;
  onContinue: () => void;
  onSkip: () => void;
  behind: { count: number; upstream: string } | null;
  onPull: () => void;
  coAuthors: Author[];
  onCoAuthorMenu: (e: React.MouseEvent) => void;
  onRemoveCoAuthor: (a: Author) => void;
  onIgnoredMenu: (e: React.MouseEvent, path: string) => void;
  onEditGitignore: () => void;
}

const STATE_LABEL: Record<string, string> = {
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  revert: 'Revert in progress',
};

export function StagingPanel(p: StagingProps) {
  const { status, info, sides } = p;
  const conflicts = status.conflicted.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const [showIgnored, setShowIgnored] = useState(false);
  const stepList = p.activeStaged === true ? status.staged : p.activeStaged === false ? [...status.conflicted, ...status.unstaged] : [];
  useFileStepper(stepList, p.activePath, (f) => p.onOpenDiff(f, p.activeStaged === true));
  const [ignored, setIgnored] = useState<string[] | null>(null);

  // Ignored files are only listed on demand; the list can be slow in big repos.
  useEffect(() => {
    if (!showIgnored) return;
    let alive = true;
    git<string[]>('ignoredFiles', p.repo)
      .then((l) => alive && setIgnored(l))
      .catch(() => alive && setIgnored([]));
    return () => {
      alive = false;
    };
  }, [showIgnored, p.repo, status]);
  const total = new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path)).size;
  const canCommit = (status.staged.length > 0 || p.amend || (info.state === 'merge' && status.conflicted.length === 0)) && p.summary.trim().length > 0;
  const commitLabel =
    status.staged.length === 0 && !p.amend
      ? info.state === 'merge'
        ? 'Commit merge'
        : 'Stage changes to commit'
      : p.amend
        ? 'Amend previous commit'
        : `Commit changes to ${status.staged.length} file${status.staged.length === 1 ? '' : 's'}`;

  return (
    <div className="staging">
      <div className="panel-header">
        <span>
          {total} file change{total === 1 ? '' : 's'} on <b>{info.branch ?? 'detached HEAD'}</b>
        </span>
        {total > 0 && (
          <button className="icon-btn" title="Discard all changes" onClick={p.onDiscardAll}>
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {info.state && (
        <div className="state-banner">
          <div className="state-title">
            <AlertTriangle size={14} /> {STATE_LABEL[info.state]}
          </div>
          {info.state === 'rebase' && info.opCommit && (
            <div className="state-text" title={`${sides.theirs.title} onto ${sides.ours.title}`}>
              Applying your commit <code>{info.opCommit.sha.slice(0, 7)}</code> {info.opCommit.subject}
              {info.onto ? ` onto ${info.onto.name ?? info.onto.sha.slice(0, 7)}` : ''}.
            </div>
          )}
          <div className="state-text">
            {status.conflicted.length
              ? `Resolve ${status.conflicted.length} conflicted file${status.conflicted.length === 1 ? '' : 's'}, then continue.`
              : 'All conflicts resolved.'}
          </div>
          <div className="state-actions">
            <button className="btn btn-sm btn-danger" onClick={p.onAbort}>
              Abort
            </button>
            {info.state === 'rebase' && (
              <button className="btn btn-sm" onClick={p.onSkip}>
                Skip
              </button>
            )}
            {info.state !== 'merge' && (
              <button className="btn btn-sm btn-primary" disabled={status.conflicted.length > 0} onClick={p.onContinue}>
                Continue
              </button>
            )}
          </div>
        </div>
      )}
      {!info.state && conflicts > 0 && (
        <div className="state-banner">
          <div className="state-title">
            <AlertTriangle size={14} />{' '}
            {p.stashConflict
              ? `${p.stashConflict.pop ? 'Popping' : 'Applying'} ${p.stashConflict.ref} hit conflicts`
              : `${plural(conflicts, 'file')} ${conflicts === 1 ? 'has' : 'have'} conflicts`}
          </div>
          <div className="state-text">
            {p.stashConflict
              ? `Resolve ${plural(conflicts, 'conflicted file')}. Git kept the stash, so nothing is lost; its changes stay unstaged when you're done.`
              : `Resolve ${conflicts === 1 ? 'it' : 'each one'}, then commit.`}
          </div>
        </div>
      )}

      <div className="file-sections">
        {status.conflicted.length > 0 && (
          <div className="file-section conflicted">
            <div className="file-section-header conflict">
              <span>Conflicted Files ({status.conflicted.length})</span>
            </div>
            <div className="file-list">
              {status.conflicted.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={p.activePath === f.path}
                  onClick={() => p.onOpenDiff(f, false)}
                  onContextMenu={(e) => p.onFileMenu(e, f, false)}
                  note={kindLabel(f.conflict, sides)}
                  action={
                    isDeletion(f.conflict) ? (
                      <>
                        {f.conflict !== 'both-deleted' && (
                          <button className="btn btn-xs" title="Keep the file as it is now and mark it resolved" onClick={() => p.onKeep(f)}>
                            Keep file
                          </button>
                        )}
                        <button className="btn btn-xs" title="Delete the file and mark it resolved" onClick={() => p.onDelete(f)}>
                          Delete file
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-xs" title={`Take ${sides.ours.title} for the whole file`} onClick={() => p.onResolve(f, 'ours')}>
                          {sides.ours.label}
                        </button>
                        <button className="btn btn-xs" title={`Take ${sides.theirs.title} for the whole file`} onClick={() => p.onResolve(f, 'theirs')}>
                          {sides.theirs.label}
                        </button>
                        <button className="btn btn-xs btn-primary" title="Mark as resolved (stage file)" onClick={() => p.onMarkResolved(f)}>
                          Resolved
                        </button>
                      </>
                    )
                  }
                />
              ))}
            </div>
          </div>
        )}

        <div className="file-section">
          <div className="file-section-header">
            <span>Unstaged Files ({status.unstaged.length})</span>
            {status.unstaged.length > 0 && (
              <button className="btn btn-xs btn-stage" onClick={p.onStageAll}>
                Stage all changes
              </button>
            )}
          </div>
          <div className="file-list">
            {status.unstaged.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                active={p.activePath === f.path}
                onClick={() => p.onOpenDiff(f, false)}
                onContextMenu={(e) => p.onFileMenu(e, f, false)}
                action={
                  <button className="btn btn-xs btn-stage" onClick={() => p.onStage([f])}>
                    Stage File
                  </button>
                }
              />
            ))}
          </div>
        </div>

        <div className="file-section">
          <div className="file-section-header">
            <span>Staged Files ({status.staged.length})</span>
            {status.staged.length > 0 && (
              <button className="btn btn-xs btn-unstage" onClick={p.onUnstageAll}>
                Unstage all changes
              </button>
            )}
          </div>
          <div className="file-list">
            {status.staged.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                active={p.activePath === f.path}
                onClick={() => p.onOpenDiff(f, true)}
                onContextMenu={(e) => p.onFileMenu(e, f, true)}
                action={
                  <button className="btn btn-xs btn-unstage" onClick={() => p.onUnstage([f])}>
                    Unstage File
                  </button>
                }
              />
            ))}
          </div>
        </div>

        <div className="file-section">
          <div className="file-section-header clickable" onClick={() => setShowIgnored((v) => !v)}>
            <span>
              {showIgnored ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Ignored Files{showIgnored && ignored ? ` (${ignored.length})` : ''}
            </span>
            <button
              className="btn btn-xs"
              onClick={(e) => {
                e.stopPropagation();
                p.onEditGitignore();
              }}
            >
              Edit .gitignore
            </button>
          </div>
          {showIgnored && (
            <div className="file-list">
              {!ignored && <div className="side-note">Loading…</div>}
              {ignored?.map((f) => (
                <div key={f} className="file-row ignored" title={f} onContextMenu={(e) => p.onIgnoredMenu(e, f)}>
                  <EyeOff size={13} className="st" />
                  {/* bdi keeps the trailing slash of ignored folders on the right inside the rtl path box */}
                  <span className="file-path">
                    <bdi className="file-name">{f}</bdi>
                  </span>
                </div>
              ))}
              {ignored?.length === 0 && <div className="side-note">Nothing is ignored</div>}
            </div>
          )}
        </div>
      </div>

      <div className="commit-box">
        <div className="commit-box-header">
          <span>
            <GitCommitHorizontal size={14} /> Commit
          </span>
          <span className="commit-box-tools">
            <button className="icon-btn" title="Add co-authors" onClick={p.onCoAuthorMenu}>
              <Users size={14} />
            </button>
            <label className="checkbox">
              <input type="checkbox" checked={p.amend} onChange={(e) => p.setAmend(e.target.checked)} disabled={!info.head} />
              Amend
            </label>
          </span>
        </div>
        {p.behind && (
          <div className="behind-banner">
            <span>
              <b>{p.behind.upstream}</b> has {p.behind.count} commit{p.behind.count === 1 ? '' : 's'} you don't have. Pull first to avoid a merge later.
            </span>
            <button className="btn btn-xs btn-primary" onClick={p.onPull}>
              Pull
            </button>
          </div>
        )}
        <div className="summary-wrap">
          <input
            className="summary"
            placeholder="Summary"
            value={p.summary}
            onChange={(e) => p.setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) p.onCommit();
            }}
          />
          <span className={`summary-count${p.summary.length > 72 ? ' over' : ''}`}>{72 - p.summary.length}</span>
        </div>
        <textarea
          className="description"
          placeholder="Description"
          value={p.description}
          onChange={(e) => p.setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) p.onCommit();
          }}
        />
        {p.coAuthors.length > 0 && (
          <div className="coauthors">
            <span className="muted">Co-authored by</span>
            {p.coAuthors.map((a) => (
              <span key={a.email} className="coauthor" title={a.email}>
                {a.name}
                <button className="icon-btn" onClick={() => p.onRemoveCoAuthor(a)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <button className="btn btn-commit" disabled={!canCommit} onClick={p.onCommit} title={shortcut('Enter')}>
          {commitLabel}
        </button>
      </div>
    </div>
  );
}

interface CommitPanelProps {
  repo: string;
  sha: string;
  version: number;
  activePath: string | null;
  onOpenDiff: (d: CommitDetails, f: FileChange) => void;
  onSelectSha: (sha: string) => void;
  onFileMenu: (e: React.MouseEvent, f: FileChange) => void;
  toast: (m: string, k?: 'error' | 'info' | 'success') => void;
  stash: Stash | null; // set when the selected commit is a stash
  onStashAction: (action: 'apply' | 'pop' | 'drop') => void;
}

export function CommitPanel({ repo, sha, version, activePath, onOpenDiff, onSelectSha, onFileMenu, toast, stash, onStashAction }: CommitPanelProps) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFileStepper(details?.sha === sha ? details.files : [], activePath, (f) => details && onOpenDiff(details, f));

  useEffect(() => {
    let alive = true;
    setError(null);
    git<CommitDetails>('commitDetails', repo, sha)
      .then((d) => alive && setDetails(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, sha, version]);

  if (error) return <div className="panel-empty">{error}</div>;
  if (!details || details.sha !== sha) return <div className="panel-empty">Loading…</div>;

  const [subject, ...bodyLines] = details.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const counts = { M: 0, A: 0, D: 0, R: 0 };
  details.files.forEach((f) => {
    const k = (f.status === 'C' ? 'A' : f.status) as keyof typeof counts;
    if (k in counts) counts[k]++;
    else counts.M++;
  });
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success');
  };

  return (
    <div className="commit-panel">
      {stash && (
        <div className="stash-banner">
          <span>
            <b>Stash</b> · {stash.ref}
          </span>
          <span className="stash-actions">
            <button className="btn btn-xs btn-primary" onClick={() => onStashAction('apply')}>
              Apply
            </button>
            <button className="btn btn-xs" onClick={() => onStashAction('pop')}>
              Pop
            </button>
            <button className="btn btn-xs btn-danger-ghost" onClick={() => onStashAction('drop')}>
              Delete
            </button>
          </span>
        </div>
      )}
      <div className="panel-header">
        <span className="sha-line">
          commit: <code>{details.sha.slice(0, 7)}</code>
          <button className="icon-btn" title="Copy SHA" onClick={() => copy(details.sha)}>
            <CopyIcon size={12} />
          </button>
        </span>
        <span className="parents">
          {details.parents.map((p) => (
            <span key={p}>
              parent:{' '}
              <a className="link" onClick={() => onSelectSha(p)}>
                {p.slice(0, 7)}
              </a>
            </span>
          ))}
        </span>
      </div>
      <div className="commit-message">
        <div className="commit-subject">{subject}</div>
        {body && <pre className="commit-body">{body}</pre>}
      </div>
      <div className="commit-author">
        <Avatar name={details.author} color={authorColor(details.email)} size={30} />
        <div>
          <div className="author-name">
            {details.author} <span className="muted">&lt;{details.email}&gt;</span>
          </div>
          <div className="muted" title={formatDate(details.time)}>
            authored {formatDate(details.time)} ({relativeTime(details.time)})
          </div>
          {(details.committer !== details.author || details.commitTime !== details.time) && (
            <div className="muted">
              committed by {details.committer} · {formatDate(details.commitTime)}
            </div>
          )}
        </div>
      </div>
      <div className="file-summary">
        {counts.M > 0 && (
          <span className="st-mod">
            <Pencil size={12} /> {counts.M} modified
          </span>
        )}
        {counts.A > 0 && (
          <span className="st-add">
            <Plus size={12} /> {counts.A} added
          </span>
        )}
        {counts.D > 0 && (
          <span className="st-del">
            <Minus size={12} /> {counts.D} deleted
          </span>
        )}
        {counts.R > 0 && (
          <span className="st-ren">
            <ArrowRight size={12} /> {counts.R} renamed
          </span>
        )}
        {details.parents.length > 1 && <span className="muted">(changes vs. first parent)</span>}
      </div>
      <div className="file-list grow">
        {details.files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            active={activePath === f.path}
            onClick={() => onOpenDiff(details, f)}
            onContextMenu={(e) => onFileMenu(e, f)}
          />
        ))}
        {details.files.length === 0 && (
          <div className="panel-empty">
            <FileQuestion size={16} /> No file changes
          </div>
        )}
      </div>
    </div>
  );
}

interface ComparePanelProps {
  repo: string;
  base: Commit; // older side
  target: Commit; // newer side
  version: number;
  activePath: string | null;
  onOpenDiff: (f: FileChange) => void;
  onSelectSha: (sha: string) => void;
  onFileMenu: (e: React.MouseEvent, f: FileChange) => void;
  onSwap: () => void;
  onClose: () => void;
}

export function ComparePanel({ repo, base, target, version, activePath, onOpenDiff, onSelectSha, onFileMenu, onSwap, onClose }: ComparePanelProps) {
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFileStepper(files ?? [], activePath, onOpenDiff);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(null);
    git<FileChange[]>('diffRange', repo, base.sha, target.sha)
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, base.sha, target.sha, version]);

  const end = (label: string, c: Commit) => (
    <div className="compare-end">
      <span className="muted">{label}</span>
      <Avatar name={c.author} color={authorColor(c.email)} size={20} />
      <a className="link" onClick={() => onSelectSha(c.sha)}>
        <code>{c.sha.slice(0, 7)}</code>
      </a>
      <span className="compare-subject" title={c.subject}>
        {c.subject}
      </span>
    </div>
  );

  return (
    <div className="commit-panel compare-panel">
      <div className="panel-header">
        <span>Comparing 2 commits</span>
        <span>
          <button className="icon-btn" title="Swap sides" onClick={onSwap}>
            <ArrowUpDown size={14} />
          </button>
          <button className="icon-btn" title="Stop comparing" onClick={onClose}>
            <X size={14} />
          </button>
        </span>
      </div>
      <div className="compare-ends">
        {end('from', base)}
        {end('to', target)}
      </div>
      <div className="file-summary">
        {files ? `${files.length} file${files.length === 1 ? '' : 's'} changed` : error ? '' : 'Loading…'}
      </div>
      <div className="file-list grow">
        {error && <div className="panel-empty">{error}</div>}
        {files?.map((f) => (
          <FileRow key={f.path} file={f} active={activePath === f.path} onClick={() => onOpenDiff(f)} onContextMenu={(e) => onFileMenu(e, f)} />
        ))}
        {files && files.length === 0 && (
          <div className="panel-empty">
            <FileQuestion size={16} /> No differences
          </div>
        )}
      </div>
    </div>
  );
}
