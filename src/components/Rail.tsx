import { useState } from 'react';
import { Code2, FileDiff, FolderOpen, GitPullRequest, Home, Plus, Search, Settings, SquareTerminal, Waypoints } from 'lucide-react';
import type { RepoStats } from '../types';
import { basename } from '../api';
import { shortcut } from '../lib/settings';

export interface RailTab {
  id: number;
  path: string | null;
}

interface Props {
  tabs: RailTab[];
  active: number;
  stats: RepoStats | null; // null when the active tab isn't a repository
  onSelect: (id: number) => void;
  onTabMenu: (e: React.MouseEvent, id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onView: (view: 'view-history' | 'view-changes' | 'view-prs') => void;
  onSearch: () => void;
  onSettings: () => void;
  onEditor: () => void;
  onTerminal: () => void;
  onReveal: () => void;
}

// Two letters for a repo tile: initials of the first two words, else the first two letters.
export function repoInitials(path: string) {
  const words = basename(path).split(/[-_.\s]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

interface Tip {
  title: string;
  detail?: string;
  x: number;
  y: number;
}

export function Rail({ tabs, active, stats, onSelect, onTabMenu, onClose, onNew, onView, onSearch, onSettings, onEditor, onTerminal, onReveal }: Props) {
  // The rail is icons only, so every button gets a tooltip to its right, shown on hover or keyboard focus.
  const [tip, setTip] = useState<Tip | null>(null);
  const tipProps = (title: string, detail?: string) => {
    const show = (e: React.SyntheticEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ title, detail, x: r.right + 8, y: r.top + r.height / 2 });
    };
    const hide = () => setTip(null);
    return { onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide, onMouseDown: hide, 'aria-label': detail ? `${title}, ${detail}` : title };
  };

  const changes = stats?.changes ?? 0;
  const prs = stats?.prs ?? 0;

  return (
    <nav className="rail" aria-label="Workspace">
      <div className="rail-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`rail-tile${t.id === active ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose(t.id)}
            onContextMenu={(e) => onTabMenu(e, t.id)}
            {...tipProps(t.path ? basename(t.path) : 'New tab', t.path ?? undefined)}
          >
            {t.path ? repoInitials(t.path) : <Home size={15} />}
          </button>
        ))}
        <button className="rail-tile add" onClick={onNew} {...tipProps('Open another repository', `New tab · ${shortcut('T')}`)}>
          <Plus size={14} />
        </button>
      </div>
      {stats && (
        <>
          <span className="rail-sep" />
          <button className={`rail-btn${stats.view === 'history' ? ' active' : ''}`} onClick={() => onView('view-history')} {...tipProps('History', 'Commit graph')}>
            <Waypoints size={18} />
          </button>
          <button
            className={`rail-btn${stats.view === 'changes' ? ' active' : ''}`}
            onClick={() => onView('view-changes')}
            {...tipProps('Changes', changes ? `${changes} uncommitted change${changes === 1 ? '' : 's'}` : 'No uncommitted changes')}
          >
            <FileDiff size={18} />
            {changes > 0 && <span className="rail-badge changes">{changes}</span>}
          </button>
          <button className="rail-btn" onClick={() => onView('view-prs')} {...tipProps('Pull requests', prs ? `${prs} open` : 'None open')}>
            <GitPullRequest size={18} />
            {prs > 0 && <span className="rail-badge prs">{prs}</span>}
          </button>
          <button className="rail-btn" onClick={onSearch} {...tipProps('Search and commands', shortcut('P'))}>
            <Search size={18} />
          </button>
        </>
      )}
      <span className="rail-spacer" />
      {stats && (
        <>
          <button className="rail-btn" onClick={onEditor} {...tipProps('Open in editor', 'Change the editor in Settings')}>
            <Code2 size={18} />
          </button>
          <button className="rail-btn" onClick={onTerminal} {...tipProps('Open terminal', 'In this repository')}>
            <SquareTerminal size={18} />
          </button>
          <button className="rail-btn" onClick={onReveal} {...tipProps('Show in folder')}>
            <FolderOpen size={18} />
          </button>
          <span className="rail-sep" />
        </>
      )}
      <button className="rail-btn" onClick={onSettings} {...tipProps('Settings', shortcut(','))}>
        <Settings size={18} />
      </button>
      {tip && (
        <div className="rail-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <span className="rail-tip-title">{tip.title}</span>
          {tip.detail && <span className="rail-tip-detail">{tip.detail}</span>}
        </div>
      )}
    </nav>
  );
}
