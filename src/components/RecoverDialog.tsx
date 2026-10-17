import { useEffect, useState } from 'react';
import { git } from '../api';
import { relativeTime, formatDate } from '../lib/format';

interface Entry {
  sha: string;
  ref: string;
  action: string;
  time: number;
  subject: string;
  lost: boolean;
}

interface Props {
  repo: string;
  onClose: () => void;
  onCreateBranch: (sha: string) => void;
  onShow: (sha: string) => void;
}

// HEAD's reflog, for getting back commits lost to a reset, an amend, a rebase or a deleted branch.
export function RecoverDialog({ repo, onClose, onCreateBranch, onShow }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [onlyLost, setOnlyLost] = useState(true);

  useEffect(() => {
    git<Entry[]>('reflog', repo).then(setEntries);
  }, [repo]);

  const shown = (entries ?? []).filter((e, i, all) => (!onlyLost || e.lost) && all.findIndex((x) => x.sha === e.sha) === i);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal recover-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">Recover lost commits</div>
        <p className="recover-help">
          Everywhere this repository's HEAD has pointed recently. Commits marked <span className="lost-badge">not on any branch</span> were left
          behind by a reset, amend, rebase or deleted branch; create a branch on one to keep it.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={onlyLost} onChange={(e) => setOnlyLost(e.target.checked)} />
          Only show commits that aren't on any branch
        </label>
        <div className="recover-list">
          {!entries && <div className="side-note">Loading…</div>}
          {entries && shown.length === 0 && (
            <div className="side-note">{onlyLost ? 'Nothing lost: every recent commit is still on a branch.' : 'No history yet.'}</div>
          )}
          {shown.map((e) => (
            <div key={e.ref} className="recover-row">
              <div className="recover-main">
                <div className="recover-subject">
                  {e.subject}
                  {e.lost && <span className="lost-badge">not on any branch</span>}
                </div>
                <div className="recover-meta">
                  <code>{e.sha.slice(0, 7)}</code> · {e.action} · <span title={formatDate(e.time)}>{relativeTime(e.time)}</span>
                </div>
              </div>
              <button className="btn btn-xs btn-primary" onClick={() => onCreateBranch(e.sha)}>
                Create branch here
              </button>
              {!e.lost && (
                <button className="btn btn-xs" onClick={() => onShow(e.sha)}>
                  Show
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
