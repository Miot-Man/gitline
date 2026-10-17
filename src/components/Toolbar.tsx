import { ArrowDown, ArrowUp, GitBranch, Archive, ArchiveRestore, ChevronDown, SquareTerminal, FolderOpen, Loader2, RefreshCw, Undo2, Redo2 } from 'lucide-react';

export type PullMode = 'ff' | 'ff-only' | 'rebase';

export const PULL_LABELS: Record<PullMode, string> = {
  ff: 'Pull (fast-forward if possible)',
  'ff-only': 'Pull (fast-forward only)',
  rebase: 'Pull (rebase)',
};

interface Props {
  repoName: string;
  branch: string | null;
  busy: string | null;
  ahead: number;
  behind: number;
  canPop: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onRepoMenu: (e: React.MouseEvent) => void;
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
  onTerminal: () => void;
  onReveal: () => void;
}

function ToolButton({ icon, label, onClick, disabled, badge, title }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; badge?: number; title?: string }) {
  return (
    <button className="tool-btn" onClick={onClick} disabled={disabled} title={title}>
      <span className="tool-icon">
        {icon}
        {!!badge && <span className="tool-badge">{badge}</span>}
      </span>
      <span className="tool-label">{label}</span>
    </button>
  );
}

export function Toolbar(p: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="crumb" onClick={p.onRepoMenu}>
          <span className="crumb-label">repository</span>
          <span className="crumb-value">
            {p.repoName} <ChevronDown size={12} />
          </span>
        </button>
        <span className="crumb-sep" />
        <button className="crumb" onClick={p.onBranchMenu}>
          <span className="crumb-label">branch</span>
          <span className="crumb-value">
            <GitBranch size={12} /> {p.branch ?? 'detached HEAD'} <ChevronDown size={12} />
          </span>
        </button>
      </div>
      <div className="toolbar-center">
        <ToolButton icon={<Undo2 size={18} />} label="Undo" onClick={p.onUndo} disabled={!!p.busy || !p.undoLabel} title={p.undoLabel ? `Undo ${p.undoLabel} (⌘Z)` : 'Nothing to undo'} />
        <ToolButton icon={<Redo2 size={18} />} label="Redo" onClick={p.onRedo} disabled={!!p.busy || !p.redoLabel} title={p.redoLabel ? `Redo ${p.redoLabel} (⇧⌘Z)` : 'Nothing to redo'} />
        <span className="tool-sep" />
        <ToolButton icon={<RefreshCw size={18} />} label="Fetch" onClick={p.onFetch} disabled={!!p.busy} />
        <div className="split-btn">
          <ToolButton icon={<ArrowDown size={18} />} label="Pull" onClick={p.onPull} disabled={!!p.busy} badge={p.behind} />
          <button className="split-caret" onClick={p.onPullMenu} disabled={!!p.busy}>
            <ChevronDown size={12} />
          </button>
        </div>
        <ToolButton icon={<ArrowUp size={18} />} label="Push" onClick={p.onPush} disabled={!!p.busy} badge={p.ahead} />
        <span className="tool-sep" />
        <ToolButton icon={<GitBranch size={18} />} label="Branch" onClick={p.onBranch} disabled={!!p.busy} />
        <span className="tool-sep" />
        <ToolButton icon={<Archive size={18} />} label="Stash" onClick={p.onStash} disabled={!!p.busy} />
        <ToolButton icon={<ArchiveRestore size={18} />} label="Pop" onClick={p.onPop} disabled={!!p.busy || !p.canPop} />
      </div>
      <div className="toolbar-right">
        {p.busy && (
          <span className="busy">
            <Loader2 size={14} className="spin" /> {p.busy}
          </span>
        )}
        <ToolButton icon={<FolderOpen size={18} />} label="Reveal" onClick={p.onReveal} />
        <ToolButton icon={<SquareTerminal size={18} />} label="Terminal" onClick={p.onTerminal} />
      </div>
    </div>
  );
}
