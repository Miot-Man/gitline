import { useEffect, useMemo, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { api, basename, cleanError, git, joinPath } from '../api';
import { relativeTime } from '../lib/format';
import { shortcut } from '../lib/settings';
import { useUI } from './ui';

const FOLDER_HINT = api.platform === 'win32' ? 'C:\\Users\\you\\code' : api.platform === 'darwin' ? '/Users/you/code' : '/home/you/code';

interface Props {
  onOpen: (path: string) => void;
  mode: 'home' | 'clone' | 'init';
  setMode: (m: 'home' | 'clone' | 'init') => void;
}

interface RepoSummary {
  branch: string | null;
  upstream: boolean;
  ahead: number;
  behind: number;
  changes: number;
  origin: string | null;
}

// "~/code/x" rather than "/Users/you/code/x": shorter, and the part that differs is what matters.
function useTidyPath() {
  const [home, setHome] = useState('');
  useEffect(() => {
    api.home().then(setHome);
  }, []);
  return (p: string) => (home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\')) ? '~' + p.slice(home.length) : p);
}

// Recent repos plus a summary of each, read from disk (no network), for the list and for spotting
// GitHub repos that are already cloned.
function useRecent() {
  const [recent, setRecent] = useState<string[] | null>(null);
  const [opened, setOpened] = useState<Record<string, number>>({});
  const [summaries, setSummaries] = useState<Record<string, RepoSummary | null>>({});
  const reload = async () => {
    const [list, times] = await Promise.all([api.recent.get(), api.recent.opened()]);
    setRecent(list);
    setOpened(times);
    for (const p of list) {
      git<RepoSummary>('repoSummary', p)
        .then((s) => setSummaries((m) => ({ ...m, [p]: s })))
        .catch(() => setSummaries((m) => ({ ...m, [p]: null })));
    }
  };
  useEffect(() => {
    reload();
  }, []);
  return { recent, opened, summaries, reload };
}

function statusOf(s: RepoSummary | null | undefined) {
  if (s === undefined) return { text: '', busy: false };
  if (s === null) return { text: "Couldn't read", busy: true };
  const parts = [];
  if (s.behind) parts.push(`↓${s.behind}`);
  if (s.ahead) parts.push(`↑${s.ahead}`);
  if (s.changes) parts.push(`${s.changes} change${s.changes === 1 ? '' : 's'}`);
  if (parts.length) return { text: parts.join(' · '), busy: true };
  return { text: s.upstream ? 'Up to date' : 'No upstream', busy: false };
}

export function Welcome({ onOpen, mode, setMode }: Props) {
  return (
    <div className="welcome">
      {mode === 'home' && <RepoList onOpen={onOpen} setMode={setMode} />}
      {mode === 'clone' && <ClonePage onDone={onOpen} onCancel={() => setMode('home')} />}
      {mode === 'init' && <InitPage onDone={onOpen} onCancel={() => setMode('home')} />}
    </div>
  );
}

function RepoList({ onOpen, setMode }: { onOpen: (p: string) => void; setMode: Props['setMode'] }) {
  const ui = useUI();
  const tidy = useTidyPath();
  const { recent, opened, summaries, reload } = useRecent();
  const [filter, setFilter] = useState('');

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
      reload();
    }
  };

  const f = filter.trim().toLowerCase();
  const shown = (recent ?? []).filter((p) => !f || p.toLowerCase().includes(f) || (summaries[p]?.branch ?? '').toLowerCase().includes(f));

  return (
    <div className="home">
      <div className="home-head">
        <h1>Repositories</h1>
        {recent && recent.length > 0 && <span className="home-count">{recent.length}</span>}
        <span className="spacer" />
        {recent && recent.length > 0 && (
          <label className="home-filter">
            <Search size={14} />
            <input aria-label="Filter repositories" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        <div className="btn-group">
          <button className="btn" onClick={openDialog} title={`Open a repository (${shortcut('O')})`}>
            Open…
          </button>
          <button className="btn" onClick={() => setMode('clone')} title={`Clone a repository (${shortcut('N')})`}>
            Clone…
          </button>
          <button className="btn" onClick={() => setMode('init')} title={`New repository (${shortcut('I')})`}>
            New…
          </button>
        </div>
      </div>

      {recent && recent.length === 0 && (
        <div className="home-empty">
          <p>No repositories yet.</p>
          <p>Open a folder that's already a Git repository, clone one from GitHub or a URL, or start a new one.</p>
        </div>
      )}

      {recent && recent.length > 0 && (
        <div className="repo-table" role="table" aria-label="Recent repositories">
          <div className="repo-row repo-row-head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Branch</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="repo-opened">
              Opened
            </span>
            <span />
          </div>
          {shown.map((p) => {
            const s = summaries[p];
            const st = statusOf(s);
            return (
              <div key={p} className="repo-row" role="row" tabIndex={0} onClick={() => openRecent(p)} onKeyDown={(e) => e.key === 'Enter' && openRecent(p)}>
                <span role="cell" className="repo-name-cell">
                  <span className="repo-name">{basename(p)}</span>
                  <span className="repo-path" title={p}>
                    {tidy(p)}
                  </span>
                </span>
                <span role="cell" className="repo-branch">
                  {s && <span className="repo-dot" />}
                  {s ? (s.branch ?? 'detached') : ''}
                </span>
                <span role="cell" className={`repo-status${st.busy ? ' busy' : ''}`}>
                  {st.text}
                </span>
                <span role="cell" className="repo-opened">
                  {opened[p] ? relativeTime(Math.floor(opened[p] / 1000)) : ''}
                </span>
                <button
                  className="icon-btn"
                  title="Remove from list"
                  aria-label={`Remove ${basename(p)} from list`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.recent.remove(p);
                    reload();
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          {shown.length === 0 && <div className="repo-none">Nothing matches “{filter}”.</div>}
        </div>
      )}

      <div className="home-hints">
        <span>
          <kbd>{shortcut('O')}</kbd> open
        </span>
        <span>
          <kbd>{shortcut('N')}</kbd> clone
        </span>
        <span>
          <kbd>{shortcut('I')}</kbd> new
        </span>
        <span>
          <kbd>{shortcut('P')}</kbd> commands
        </span>
      </div>
    </div>
  );
}

interface GhRepo {
  name: string;
  description: string | null;
  private: boolean;
  url: string;
  updated: string;
  language: string | null;
}

const nameFromUrl = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .split(/[/:\\]/)
    .pop()
    ?.replace(/\.git$/, '') ?? '';

// "owner/name" from any GitHub-style URL (https, ssh or scp-like), to match clones against repos.
const slugFromUrl = (url: string) =>
  url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split(/[/:\\]/)
    .slice(-2)
    .join('/')
    .toLowerCase();

const looksLikeUrl = (s: string) => /^(https?:\/\/|ssh:\/\/|git@|git:\/\/|file:\/\/)/.test(s.trim());

// Leads with where the repo lives ("Change…" picks the parent), so the destination is one line, not two fields.
function Destination({
  parent,
  setParent,
  name,
  setName,
  label,
}: {
  parent: string;
  setParent: (p: string) => void;
  name: string;
  /** Leave out when the name is typed elsewhere on the page; it's then just shown. */
  setName?: (n: string) => void;
  label: string;
}) {
  const tidy = useTidyPath();
  const sep = api.platform === 'win32' ? '\\' : '/';
  return (
    <div className="dest">
      <span className="dest-label">{label}</span>
      <div className="dest-path">
        {parent ? (
          <span className="dest-parent" title={parent}>
            {tidy(parent).replace(/[\\/]+$/, '') + sep}
          </span>
        ) : (
          <span className="dest-parent dest-unset">{FOLDER_HINT + sep}</span>
        )}
        {setName ? <input aria-label="Folder name" value={name} placeholder="folder-name" onChange={(e) => setName(e.target.value)} /> : <span className="dest-name">{name}</span>}
        <button
          className="dest-change"
          onClick={async () => {
            const p = await api.pickFolder(label);
            if (p) setParent(p);
          }}
        >
          {parent ? 'Change…' : 'Choose…'}
        </button>
      </div>
    </div>
  );
}

function PageHead({ title, onHome, children }: { title: string; onHome: () => void; children?: React.ReactNode }) {
  return (
    <div className="home-head">
      <button className="crumb" onClick={onHome}>
        Home
      </button>
      <span className="crumb-sep">/</span>
      <h1>{title}</h1>
      <span className="spacer" />
      {children}
    </div>
  );
}

function ClonePage({ onDone, onCancel }: { onDone: (p: string) => void; onCancel: () => void }) {
  const ui = useUI();
  const { recent, summaries } = useRecent();
  const [tab, setTab] = useState<'github' | 'url'>('github');
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(() => localStorage.getItem('cloneParent') ?? '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  // The signed-in GitHub user's repositories (via gh), so cloning can be a search and a click.
  const [mine, setMine] = useState<GhRepo[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('');
  useEffect(() => {
    git<GhRepo[]>('ghMyRepos', '')
      .then(setMine)
      .catch((e) => {
        setMineError(cleanError(e));
        setTab('url');
      });
  }, []);

  // Repos that are already on this computer, by origin, so they open instead of cloning twice.
  const cloned = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of recent ?? []) {
      const o = summaries[p]?.origin;
      if (o) m.set(slugFromUrl(o), p);
    }
    return m;
  }, [recent, summaries]);

  const owners = useMemo(() => [...new Set((mine ?? []).map((r) => r.name.split('/')[0]))], [mine]);
  const q = query.trim().toLowerCase();
  const shown = (mine ?? []).filter((r) => (!owner || r.name.startsWith(owner + '/')) && (!q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)));

  const effectiveName = nameTouched ? name : nameFromUrl(url);
  const existing = url ? cloned.get(slugFromUrl(url)) : undefined;

  const pick = (u: string) => {
    setUrl(u);
    setNameTouched(false);
  };

  const clone = async () => {
    if (existing) return onDone(existing);
    if (!url.trim() || !parent || !effectiveName || busy) return;
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
    <div className="home home-with-bar">
      <PageHead title="Clone" onHome={onCancel}>
        <div className="btn-group" role="tablist" aria-label="Clone from">
          <button role="tab" aria-selected={tab === 'github'} className={`btn${tab === 'github' ? ' active' : ''}`} onClick={() => setTab('github')}>
            GitHub
          </button>
          <button role="tab" aria-selected={tab === 'url'} className={`btn${tab === 'url' ? ' active' : ''}`} onClick={() => setTab('url')}>
            URL
          </button>
        </div>
      </PageHead>

      {tab === 'github' && (
        <>
          <div className="clone-search">
            <label className="home-filter grow">
              <Search size={14} />
              <input
                autoFocus
                aria-label="Search your GitHub repositories"
                placeholder={mine ? `Search ${mine.length} repositories, or paste any URL` : 'Loading your repositories…'}
                value={query}
                onChange={(e) => {
                  const v = e.target.value;
                  // A pasted URL means "clone this", whatever it is.
                  if (looksLikeUrl(v)) {
                    pick(v.trim());
                    setQuery('');
                    setTab('url');
                  } else setQuery(v);
                }}
              />
            </label>
            {owners.length > 1 && (
              <select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">All owners</option>
                {owners.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            )}
          </div>
          <div className="gh-list" role="listbox" aria-label="Your repositories">
            {!mine && (
              <div className="repo-none">
                <Loader2 size={14} className="spin" /> Loading your repositories…
              </div>
            )}
            {shown.map((r) => {
              const here = cloned.get(slugFromUrl(r.url));
              return (
                <div
                  key={r.name}
                  role="option"
                  aria-selected={url === r.url}
                  tabIndex={0}
                  className={`gh-row${url === r.url ? ' active' : ''}${here ? ' cloned' : ''}`}
                  onClick={() => pick(r.url)}
                  onDoubleClick={clone}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') url === r.url ? clone() : pick(r.url);
                  }}
                >
                  <span className="gh-radio" />
                  <span className="gh-main">
                    <span className="gh-title">
                      <span className="gh-name">{r.name}</span>
                      {r.private && <span className="gh-private">private</span>}
                    </span>
                    {r.description && <span className="gh-desc">{r.description}</span>}
                  </span>
                  <span className="gh-lang">{r.language ?? ''}</span>
                  <span className="gh-note">{here ? 'Already cloned' : r.updated ? `Updated ${relativeTime(Math.floor(Date.parse(r.updated) / 1000))}` : ''}</span>
                </div>
              );
            })}
            {mine && shown.length === 0 && <div className="repo-none">No repositories match “{query}”.</div>}
          </div>
        </>
      )}

      {tab === 'url' && (
        <div className="clone-url">
          <label className="field">
            <span>Repository URL</span>
            <input
              autoFocus
              placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
              value={url}
              onChange={(e) => pick(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && clone()}
            />
          </label>
          {mineError && <div className="field-hint">Sign in with the GitHub CLI (gh auth login) to pick from your own repositories.</div>}
        </div>
      )}

      <div className="home-bar">
        {existing ? (
          <span className="dest-label grow">
            Already cloned at <span className="mono">{existing}</span>
          </span>
        ) : (
          <Destination
            label="Clone into"
            parent={parent}
            setParent={setParent}
            name={effectiveName}
            setName={(n) => {
              setNameTouched(true);
              setName(n);
            }}
          />
        )}
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || (!existing && (!url.trim() || !parent || !effectiveName))} onClick={clone}>
          {busy ? (
            <>
              <Loader2 size={14} className="spin" /> Cloning…
            </>
          ) : existing ? (
            'Open'
          ) : (
            'Clone'
          )}
        </button>
      </div>
    </div>
  );
}

function InitPage({ onDone, onCancel }: { onDone: (p: string) => void; onCancel: () => void }) {
  const ui = useUI();
  const [parent, setParent] = useState(() => localStorage.getItem('cloneParent') ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = !!parent && !!name.trim() && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const dest = await git<string>('init', joinPath(parent, name.trim()));
      ui.toast(`Created ${dest}`, 'success');
      onDone(dest);
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home home-with-bar">
      <PageHead title="New repository" onHome={onCancel} />
      <div className="clone-url">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>
        <div className="field-hint">Creates an empty folder with a new Git repository in it, on your default branch.</div>
      </div>
      <div className="home-bar">
        <Destination label="Create in" parent={parent} setParent={setParent} name={name.trim()} />
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready} onClick={create}>
          Create
        </button>
      </div>
    </div>
  );
}
