import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { RepoStats } from '../types';
import type { UpdateState } from '../api';
import { relativeTime } from '../lib/format';
import { shortcut } from '../lib/settings';

interface Props {
  stats: RepoStats | null;
  onChanges: () => void;
  onUndo: () => void;
  onPalette: () => void;
  update: UpdateState;
  onInstallUpdate: () => void;
}

export function StatusBar({ stats, onChanges, onUndo, onPalette, update, onInstallUpdate }: Props) {
  // Re-render every 30s so "Fetched 2 minutes ago" stays current.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className="statusbar">
      {stats ? (
        <>
          <span className="status-branch">
            <span className="status-dot" />
            {stats.branch ?? 'no branch'}
          </span>
          {(stats.ahead > 0 || stats.behind > 0) && (
            <span className="status-mono" title={`${stats.behind} to pull, ${stats.ahead} to push`}>
              ↓{stats.behind} ↑{stats.ahead}
            </span>
          )}
          <span>{stats.fetchedAt ? `Fetched ${relativeTime(Math.floor(stats.fetchedAt / 1000))}` : 'Not fetched yet'}</span>
          {stats.changes > 0 && (
            <button className="status-link changes" onClick={onChanges}>
              {stats.changes} uncommitted change{stats.changes === 1 ? '' : 's'}
            </button>
          )}
          {stats.busy && (
            <span className="status-busy">
              <Loader2 size={12} className="spin" /> {stats.busy}
            </span>
          )}
        </>
      ) : (
        <span>No repository open</span>
      )}
      <span className="status-spacer" />
      {update.status === 'available' && (
        <button className="status-link update" onClick={() => window.open(update.url)}>
          Gitline {update.version} is available · Download
        </button>
      )}
      {update.status === 'downloading' && <span className="status-update">Downloading Gitline {update.version}… {update.percent}%</span>}
      {update.status === 'ready' && (
        <button className="status-link update" onClick={onInstallUpdate}>
          Restart to update to {update.version}
        </button>
      )}
      {stats?.undoLabel && (
        <button className="status-link" onClick={onUndo} title={`Undo (${shortcut('Z')})`}>
          Undo: {stats.undoLabel}
        </button>
      )}
      <button className="status-link status-mono" onClick={onPalette}>
        {shortcut('P')}
      </button>
    </footer>
  );
}
