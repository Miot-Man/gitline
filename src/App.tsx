import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X, FolderGit2, Home } from 'lucide-react';
import { api, basename, cleanError } from './api';
import { UIProvider, useUI } from './components/ui';
import { RepoView } from './components/RepoView';
import { Welcome } from './components/Welcome';

interface Tab {
  id: number;
  path: string | null;
}

type WelcomeMode = 'home' | 'clone' | 'init';

function loadTabs(): { tabs: Tab[]; active: number } {
  try {
    const saved = JSON.parse(localStorage.getItem('tabs') ?? '');
    if (Array.isArray(saved.tabs) && saved.tabs.length) return saved;
  } catch {}
  return { tabs: [{ id: 1, path: null }], active: 1 };
}

function Shell() {
  const ui = useUI();
  const [{ tabs, active }, setState] = useState(loadTabs);
  const [welcomeMode, setWelcomeMode] = useState<WelcomeMode>('home');
  const [command, setCommand] = useState<{ name: string; n: number } | null>(null);
  const stateRef = useRef({ tabs, active });
  stateRef.current = { tabs, active };

  useEffect(() => {
    localStorage.setItem('tabs', JSON.stringify({ tabs, active }));
  }, [tabs, active]);

  const nextId = () => Math.max(0, ...stateRef.current.tabs.map((t) => t.id)) + 1;

  const openRepo = useCallback((path: string) => {
    api.recent.add(path);
    setWelcomeMode('home');
    setState(({ tabs, active }) => {
      const existing = tabs.find((t) => t.path === path);
      if (existing) return { tabs, active: existing.id };
      const cur = tabs.find((t) => t.id === active);
      if (cur && cur.path === null) return { tabs: tabs.map((t) => (t.id === active ? { ...t, path } : t)), active };
      const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
      return { tabs: [...tabs, { id, path }], active: id };
    });
  }, []);

  const newTab = useCallback((mode: WelcomeMode = 'home') => {
    setWelcomeMode(mode);
    setState(({ tabs, active }) => {
      const cur = tabs.find((t) => t.id === active);
      if (cur && cur.path === null) return { tabs, active };
      const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
      return { tabs: [...tabs, { id, path: null }], active: id };
    });
  }, []);

  const closeTab = useCallback((id: number) => {
    setState(({ tabs, active }) => {
      const idx = tabs.findIndex((t) => t.id === id);
      const rest = tabs.filter((t) => t.id !== id);
      if (!rest.length) return { tabs: [{ id: id + 1, path: null }], active: id + 1 };
      const nextActive = active === id ? rest[Math.max(0, idx - 1)].id : active;
      return { tabs: rest, active: nextActive };
    });
  }, []);

  const openDialog = useCallback(async () => {
    try {
      const p = await api.openRepoDialog();
      if (p) openRepo(p);
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    }
  }, [openRepo, ui]);

  useEffect(
    () =>
      api.onMenu((cmd) => {
        switch (cmd) {
          case 'new-tab':
            return newTab();
          case 'open':
            return openDialog();
          case 'clone':
            return newTab('clone');
          case 'init':
            return newTab('init');
          case 'close-tab':
            return closeTab(stateRef.current.active);
          default:
            setCommand({ name: cmd, n: Date.now() });
        }
      }),
    [newTab, openDialog, closeTab]
  );

  const repoMenu = async (e: React.MouseEvent) => {
    const pos = { clientX: e.clientX, clientY: e.clientY };
    const recent = (await api.recent.get()).slice(0, 10);
    ui.menu(pos, [
      ...recent.map((p) => ({ label: basename(p), hint: p.replace(/^\/Users\/[^/]+/, '~'), onClick: () => openRepo(p) })),
      'sep' as const,
      { label: 'Open repository…', hint: '⌘O', onClick: openDialog },
      { label: 'Clone repository…', hint: '⌘N', onClick: () => newTab('clone') },
      { label: 'Init repository…', hint: '⌘I', onClick: () => newTab('init') },
    ]);
  };

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className={`app platform-${api.platform}`}>
      <div className="tabbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === active ? ' active' : ''}`}
            onMouseDown={() => setState((s) => ({ ...s, active: t.id }))}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            title={t.path ?? 'New tab'}
          >
            {t.path ? <FolderGit2 size={13} /> : <Home size={13} />}
            <span className="tab-name">{t.path ? basename(t.path) : 'New Tab'}</span>
            <button
              className="tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(t.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="tab-new" onClick={() => newTab()} title="New tab (⌘T)">
          <Plus size={14} />
        </button>
      </div>
      <div className="app-body">
        {tabs.map((t) =>
          t.path ? <RepoView key={t.id + t.path} path={t.path} active={t.id === active} command={t.id === active ? command : null} onRepoMenu={repoMenu} /> : null
        )}
        {activeTab && !activeTab.path && <Welcome onOpen={openRepo} mode={welcomeMode} setMode={setWelcomeMode} />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <UIProvider>
      <Shell />
    </UIProvider>
  );
}
