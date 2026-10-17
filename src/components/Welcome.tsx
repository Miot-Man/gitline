import { useEffect, useState } from 'react';
import { FolderOpen, Download, FolderPlus, X, GitBranch, Loader2 } from 'lucide-react';
import { api, basename, cleanError, git, joinPath } from '../api';
import { useUI } from './ui';

interface Props {
  onOpen: (path: string) => void;
  mode: 'home' | 'clone' | 'init';
  setMode: (m: 'home' | 'clone' | 'init') => void;
}

export function Welcome({ onOpen, mode, setMode }: Props) {
  const ui = useUI();
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    api.recent.get().then(setRecent);
  }, []);

  const openDialog = async () => {
    try {
      const p = await api.openRepoDialog();
      if (p) onOpen(p);
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    }
  };

  const openRecent = async (p: string) => {
    const top = await api.validateRepo(p);
    if (top) onOpen(top);
    else {
      ui.toast(`${p} is no longer a Git repository.`, 'error');
      await api.recent.remove(p);
      setRecent(await api.recent.get());
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <GitBranch size={34} />
          <span>Gitline</span>
        </div>
        {mode === 'home' && (
          <>
            <div className="welcome-actions">
              <button className="welcome-card" onClick={openDialog}>
                <FolderOpen size={28} />
                <span className="wc-title">Open a repository</span>
                <span className="wc-sub">Browse for a local Git repo</span>
              </button>
              <button className="welcome-card" onClick={() => setMode('clone')}>
                <Download size={28} />
                <span className="wc-title">Clone a repo</span>
                <span className="wc-sub">From a URL (GitHub, GitLab, …)</span>
              </button>
              <button className="welcome-card" onClick={() => setMode('init')}>
                <FolderPlus size={28} />
                <span className="wc-title">Start a local repo</span>
                <span className="wc-sub">Initialize a new repository</span>
              </button>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-title">Recent repositories</div>
                {recent.map((p) => (
                  <div key={p} className="recent-item" onClick={() => openRecent(p)}>
                    <FolderOpen size={14} />
                    <span className="recent-name">{basename(p)}</span>
                    <span className="recent-path">{p}</span>
                    <button
                      className="icon-btn"
                      title="Remove from list"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.recent.remove(p);
                        setRecent(await api.recent.get());
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {mode === 'clone' && <CloneForm onDone={onOpen} onCancel={() => setMode('home')} />}
        {mode === 'init' && <InitForm onDone={onOpen} onCancel={() => setMode('home')} />}
      </div>
    </div>
  );
}

const nameFromUrl = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop()
    ?.replace(/\.git$/, '') ?? '';

function CloneForm({ onDone, onCancel }: { onDone: (p: string) => void; onCancel: () => void }) {
  const ui = useUI();
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(() => localStorage.getItem('cloneParent') ?? '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const effectiveName = nameTouched ? name : nameFromUrl(url);

  const browse = async () => {
    const p = await api.pickFolder('Where to clone to');
    if (p) setParent(p);
  };

  const clone = async () => {
    setBusy(true);
    try {
      localStorage.setItem('cloneParent', parent);
      const dest = await git<string>('clone', parent, url.trim(), effectiveName);
      ui.toast(`Cloned into ${dest}`, 'success');
      onDone(dest);
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-card">
      <div className="form-title">Clone a repository</div>
      <label className="field">
        <span>URL</span>
        <input autoFocus placeholder="https://github.com/user/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="field">
        <span>Where to clone to</span>
        <div className="field-row">
          <input value={parent} placeholder="/Users/you/code" onChange={(e) => setParent(e.target.value)} />
          <button className="btn" onClick={browse}>
            Browse
          </button>
        </div>
      </label>
      <label className="field">
        <span>Folder name</span>
        <input
          value={effectiveName}
          onChange={(e) => {
            setNameTouched(true);
            setName(e.target.value);
          }}
        />
      </label>
      {parent && effectiveName && <div className="field-hint">Full path: {joinPath(parent, effectiveName)}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !url.trim() || !parent || !effectiveName} onClick={clone}>
          {busy ? (
            <>
              <Loader2 size={14} className="spin" /> Cloning…
            </>
          ) : (
            'Clone the repo!'
          )}
        </button>
      </div>
    </div>
  );
}

function InitForm({ onDone, onCancel }: { onDone: (p: string) => void; onCancel: () => void }) {
  const ui = useUI();
  const [parent, setParent] = useState(() => localStorage.getItem('cloneParent') ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const dest = await git<string>('init', joinPath(parent, name.trim()));
      ui.toast(`Initialized ${dest}`, 'success');
      onDone(dest);
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-card">
      <div className="form-title">Initialize a repository</div>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Initialize in</span>
        <div className="field-row">
          <input value={parent} placeholder="/Users/you/code" onChange={(e) => setParent(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const p = await api.pickFolder('Parent folder');
              if (p) setParent(p);
            }}
          >
            Browse
          </button>
        </div>
      </label>
      {parent && name && <div className="field-hint">Full path: {joinPath(parent, name.trim())}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !parent || !name.trim()} onClick={create}>
          Create Repository
        </button>
      </div>
    </div>
  );
}
