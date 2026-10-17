import { useEffect, useState } from 'react';
import { api, basename, cleanError, git } from '../api';
import { loadSettings, saveSettings, type PullMode, type Theme } from '../lib/settings';
import { LANGUAGES, PLAIN } from '../lib/highlight';
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

interface FolderRule {
  folder: string;
  name: string;
  email: string;
  managed?: boolean;
}

interface Effective {
  name: { value: string; origin: string };
  email: { value: string; origin: string };
}

// Where an identity setting came from, in plain words.
const identitySource = (origin: string) =>
  /[\\/]\.git[\\/]config$/.test(origin) ? "this repo's settings" : /identities/.test(origin) ? 'a folder rule' : 'your global settings';

// Global config ops ignore the directory; the backend runs them from the home folder.
const GLOBAL_CWD = '.';
const FOLDER_HINT = api.platform === 'win32' ? 'C:\\Users\\you' : api.platform === 'darwin' ? '/Users/you' : '/home/you';

export function SettingsDialog({ repo, onClose }: Props) {
  const ui = useUI();
  const [s, setS] = useState(loadSettings);
  const [globalId, setGlobalId] = useState<Identity>({ name: '', email: '' });
  const [repoId, setRepoId] = useState<Identity>({ name: '', email: '' });
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<FolderRule[]>([]);
  const [otherRules, setOtherRules] = useState<FolderRule[]>([]);
  const [rulesTouched, setRulesTouched] = useState(false);
  const [effective, setEffective] = useState<Effective | null>(null);

  useEffect(() => {
    git<FolderRule[]>('identityRules', GLOBAL_CWD).then((all) => {
      setRules(all.filter((r) => r.managed));
      setOtherRules(all.filter((r) => !r.managed));
    });
    if (repo) git<Effective>('effectiveIdentity', repo).then(setEffective);
  }, [repo]);

  const editRule = (i: number, patch: Partial<FolderRule>) => {
    setRulesTouched(true);
    setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  };
  const browseRule = async (i: number) => {
    const p = await api.pickFolder('Repositories in this folder use this identity');
    if (p) editRule(i, { folder: p });
  };

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
      if (rulesTouched) await git('saveIdentityRules', GLOBAL_CWD, rules);
      saveSettings({
        ...s,
        autoFetchMinutes: Math.max(0, Math.round(s.autoFetchMinutes) || 0),
        // Extensions (".INO") compare lowercased; anything else is an exact file name. Drop empty rows.
        syntaxRules: s.syntaxRules
          .map((r) => ({ ...r, pattern: r.pattern.trim().startsWith('.') ? r.pattern.trim().toLowerCase() : r.pattern.trim() }))
          .filter((r) => r.pattern),
      });
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

        <div className="settings-section">Syntax highlighting</div>
        <label className="checkbox settings-check">
          <input type="checkbox" checked={s.syntaxHighlighting} onChange={(e) => setS({ ...s, syntaxHighlighting: e.target.checked })} />
          Colour code in diffs
        </label>
        {s.syntaxHighlighting && (
          <>
            <div className="field-hint settings-hint">
              Gitline guesses the language from the file name. Choose one here (or from the menu above any diff) to change it for that kind of file.
            </div>
            {s.syntaxRules.map((r, i) => (
              <div key={i} className="lang-rule">
                <input
                  aria-label="File type"
                  placeholder=".ino or Makefile"
                  value={r.pattern}
                  onChange={(e) => setS({ ...s, syntaxRules: s.syntaxRules.map((x, k) => (k === i ? { ...x, pattern: e.target.value } : x)) })}
                />
                <span className="muted">→</span>
                <select
                  aria-label="Language"
                  value={r.language}
                  onChange={(e) => setS({ ...s, syntaxRules: s.syntaxRules.map((x, k) => (k === i ? { ...x, language: e.target.value } : x)) })}
                >
                  <option value={PLAIN}>Plain text</option>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <button className="btn btn-xs btn-danger-ghost" onClick={() => setS({ ...s, syntaxRules: s.syntaxRules.filter((_, k) => k !== i) })}>
                  Remove
                </button>
              </div>
            ))}
            <button className="btn btn-sm add-rule" onClick={() => setS({ ...s, syntaxRules: [...s.syntaxRules, { pattern: '', language: PLAIN }] })}>
              Add file type
            </button>
          </>
        )}

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

        <div className="settings-section">Identity by folder</div>
        <div className="field-hint settings-hint">
          Repositories inside a folder commit with that folder's name and email, from Gitline and from the terminal.
        </div>
        {rules.map((r, i) => (
          <div key={i} className="identity-rule">
            <div className="field-row">
              <input aria-label="Folder" placeholder={`${FOLDER_HINT}/uni`} value={r.folder} onChange={(e) => editRule(i, { folder: e.target.value })} />
              <button className="btn" onClick={() => browseRule(i)}>
                Browse
              </button>
            </div>
            <div className="settings-row">
              <input aria-label="Name for this folder" placeholder="Name" value={r.name} onChange={(e) => editRule(i, { name: e.target.value })} />
              <input aria-label="Email for this folder" placeholder="Email" value={r.email} onChange={(e) => editRule(i, { email: e.target.value })} />
            </div>
            <button
              className="btn btn-xs btn-danger-ghost"
              onClick={() => {
                setRulesTouched(true);
                setRules((rs) => rs.filter((_, k) => k !== i));
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {otherRules.map((r) => (
          <div key={r.folder} className="field-hint">
            Set up outside Gitline: <code>{r.folder}</code> → {r.name || '?'} &lt;{r.email || '?'}&gt;
          </div>
        ))}
        <button
          className="btn btn-sm add-rule"
          onClick={() => {
            setRulesTouched(true);
            setRules((rs) => [...rs, { folder: '', name: '', email: '' }]);
          }}
        >
          Add folder rule
        </button>
        {effective && repo && (
          <div className="field-hint settings-hint">
            {basename(repo)} commits as{' '}
            <b>
              {effective.name.value || '(no name)'} &lt;{effective.email.value || 'no email'}&gt;
            </b>
            {effective.email.origin && <> (from {identitySource(effective.email.origin)})</>}
          </div>
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

        <label className="checkbox settings-check">
          <input type="checkbox" checked={s.autoUpdate} onChange={(e) => setS({ ...s, autoUpdate: e.target.checked })} />
          Check for new versions of Gitline automatically
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
