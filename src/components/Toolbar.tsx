import { ArrowDown, ArrowUp, GitBranch, Archive, ArchiveRestore, ChevronDown, ChevronLeft, Loader2, RefreshCw, Undo2, Redo2 } from 'lucide-react';
import { shortcut, type PullMode } from '../lib/settings';

export type { PullMode };

export const PULL_LABELS: Record<PullMode, string> = {
  ff: 'Pull (fast-forward if possible)',
  'ff-only': 'Pull (fast-forward only)',
  rebase: 'Pull (rebase)',
};

export interface Crumb {
  label: string;
  mono?: boolean;
  onClick?: () => void;
}

interface Props {
  branch: string | null;
  // Replaces "History / branch" while a diff or file view is open, with a back button.
  trail: Crumb[] | null;
  onBack: () => void;
  busy: string | null;
  ahead: number;
  behind: number;
  canPop: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onBranchMenu: (e: React.MouseEvent) => void;
  onPull: () => void;
  onPullMenu: (e: React.MouseEvent) => void;
  onPush: () => void;
  onBranch: () => void;
  onStash: () => void;
  onPop: () => void;
  onFetch: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

function Btn({
  icon,
  label,
  onClick,
  disabled,
  title,
  count,
  countClass,
  iconOnly,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  count?: number;
  countClass?: string;
  iconOnly?: boolean;
}) {
  return (
    <button className={`tool-btn${iconOnly ? ' icon-only' : ''}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label}>
      {icon}
      {!iconOnly && <span className="tool-label">{label}</span>}
      {!!count && <span className={`tool-count ${countClass ?? ''}`}>{count}</span>}
    </button>
  );
}

export function Toolbar(p: Props) {
  const busy = !!p.busy;
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {p.trail ? (
          <>
            <button className="trail-back" onClick={p.onBack} title="Back to history (Esc)" aria-label="Back to history">
              <ChevronLeft size={15} />
            </button>
            <nav className="trail" aria-label="Location">
              {p.trail.map((c, i) => (
                <span key={i} className="trail-item">
                  {i > 0 && <span className="trail-sep">›</span>}
                  {c.onClick ? (
                    <button className={`trail-link${c.mono ? ' mono' : ''}`} onClick={c.onClick}>
                      {c.label}
                    </button>
                  ) : (
                    <span className={`trail-current${c.mono ? ' mono' : ''}`}>{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
          </>
        ) : (
          <nav className="trail" aria-label="Location">
            <span className="trail-muted">History</span>
            <span className="trail-sep">/</span>
            <button className="trail-branch" onClick={p.onBranchMenu} title="Switch branch">
              {p.branch ?? 'detached HEAD'} <ChevronDown size={12} />
            </button>
          </nav>
        )}
        {p.busy && (
          <span className="busy">
            <Loader2 size={13} className="spin" /> {p.busy}
          </span>
        )}
      </div>
      <div className="toolbar-right">
        <div className="tool-group undo-redo">
          <Btn
            icon={<Undo2 size={15} />}
            label="Undo"
            iconOnly
            onClick={p.onUndo}
            disabled={busy || !p.undoLabel}
            title={p.undoLabel ? `Undo ${p.undoLabel} (${shortcut('Z')})` : 'Nothing to undo'}
          />
          <Btn
            icon={<Redo2 size={15} />}
            label="Redo"
            iconOnly
            onClick={p.onRedo}
            disabled={busy || !p.redoLabel}
            title={p.redoLabel ? `Redo ${p.redoLabel} (${shortcut('Z', true)})` : 'Nothing to redo'}
          />
        </div>
        <div className="tool-group">
          <Btn icon={<RefreshCw size={14} />} label="Fetch" onClick={p.onFetch} disabled={busy} />
          <Btn icon={<ArrowDown size={15} />} label="Pull" onClick={p.onPull} disabled={busy} count={p.behind} countClass="pull" />
          <button className="split-caret" onClick={p.onPullMenu} disabled={busy} aria-label="Pull options" title="Pull options">
            <ChevronDown size={12} />
          </button>
          <Btn icon={<ArrowUp size={15} />} label="Push" onClick={p.onPush} disabled={busy} count={p.ahead} countClass="push" />
        </div>
        <div className="tool-group refs">
          <Btn icon={<GitBranch size={14} />} label="Branch" onClick={p.onBranch} disabled={busy} />
          <Btn icon={<Archive size={14} />} label="Stash" onClick={p.onStash} disabled={busy} />
          <Btn icon={<ArchiveRestore size={14} />} label="Pop" onClick={p.onPop} disabled={busy || !p.canPop} />
        </div>
      </div>
    </div>
  );
}
