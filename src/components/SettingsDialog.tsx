import { useEffect, useState } from 'react';
import { basename, cleanError, git } from '../api';
import { loadSettings, saveSettings, type PullMode, type Theme } from '../lib/settings';
import { PULL_LABELS } from './Toolbar';
import { useUI } from './ui';

interface Props {
  repo: string | null; // repo-specific identity is shown when a repo is open
  onClose: () => void;
}

interface Identity {
  name: string;
  email: string;
}

// Global config ops ignore the directory; the backend runs them from the home folder.
const GLOBAL_CWD = '.';

export function SettingsDialog({ repo, onClose }: Props) {
  const ui = useUI();
  const [s, setS] = useState(loadSettings);
  const [globalId, setGlobalId] = useState<Identity>({ name: '', email: '' });
  const [repoId, setRepoId] = useState<Identity>({ name: '', email: '' });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const get = (cwd: string, key: string, scope: string) => git<string | null>('getConfig', cwd, key, scope).then((v) => v ?? '');
    Promise.all([
      get(GLOBAL_CWD, 'user.name', 'global'),
      get(GLOBAL_CWD, 'user.email', 'global'),
      repo ? get(repo, 'user.name', 'local') : '',
      repo ? get(repo, 'user.email', 'local') : '',
    ]).then(([gn, ge, rn, re]) => {
      setGlobalId({ name: gn, email: ge });
      setRepoId({ name: rn, email: re });
      setLoaded(true);
    });
  }, [repo]);

  const save = async () => {
    try {
      await git('setConfig', GLOBAL_CWD, 'user.name', globalId.name.trim(), 'global');
      await git('setConfig', GLOBAL_CWD, 'user.email', globalId.email.trim(), 'global');
      if (repo) {
        await git('setConfig', repo, 'user.name', repoId.name.trim(), 'local');
        await git('setConfig', repo, 'user.email', repoId.email.trim(), 'local');
      }
      saveSettings({ ...s, autoFetchMinutes: Math.max(0, Math.round(s.autoFetchMinutes) || 0) });
      ui.toast('Settings saved', 'success');
      onClose();
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
      >
        <div className="modal-title">Settings</div>

        <div className="settings-section">Appearance</div>
        <div className="settings-row">
          <label className="field">
            <span>Theme</span>
            <select value={s.theme} onChange={(e) => setS({ ...s, theme: e.target.value as Theme })}>
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">
            <span>Editor command (blank = VS Code)</span>
            <input value={s.editor} placeholder="code" onChange={(e) => setS({ ...s, editor: e.target.value })} />
          </label>
        </div>

        <div className="settings-section">Git identity (all repositories)</div>
        <div className="settings-row">
          <label className="field">
            <span>Name</span>
            <input value={globalId.name} onChange={(e) => setGlobalId({ ...globalId, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Email</span>
            <input value={globalId.email} onChange={(e) => setGlobalId({ ...globalId, email: e.target.value })} />
          </label>
        </div>

        {repo && (
          <>
            <div className="settings-section">Identity for {basename(repo)} only (leave blank to use the one above)</div>
            <div className="settings-row">
              <label className="field">
                <span>Name</span>
                <input value={repoId.name} placeholder={globalId.name} onChange={(e) => setRepoId({ ...repoId, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Email</span>
                <input value={repoId.email} placeholder={globalId.email} onChange={(e) => setRepoId({ ...repoId, email: e.target.value })} />
              </label>
            </div>
          </>
        )}

        <div className="settings-section">Remotes</div>
        <div className="settings-row">
          <label className="field">
            <span>Auto-fetch every (minutes, 0 = off)</span>
            <input
              type="number"
              min={0}
              value={s.autoFetchMinutes}
              onChange={(e) => setS({ ...s, autoFetchMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Default pull</span>
            <select value={s.pullMode} onChange={(e) => setS({ ...s, pullMode: e.target.value as PullMode })}>
              {(Object.keys(PULL_LABELS) as PullMode[]).map((m) => (
                <option key={m} value={m}>
                  {PULL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="checkbox settings-check">
          <input type="checkbox" checked={s.notifyPushes} onChange={(e) => setS({ ...s, notifyPushes: e.target.checked })} />
          Notify me when someone else pushes to a branch
        </label>

        <div className="settings-section">Commit message template</div>
        <label className="field">
          <span>Prefilled into empty commit messages. Git's own commit.template takes priority if it's set. Lines starting with # are ignored.</span>
          <textarea rows={4} value={s.commitTemplate} onChange={(e) => setS({ ...s, commitTemplate: e.target.value })} />
        </label>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!loaded} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
