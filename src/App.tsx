import { useCallback, useEffect, useRef, useState } from 'react';
import { api, basename, cleanError } from './api';
import { UIProvider, useUI } from './components/ui';
import { RepoView } from './components/RepoView';
import { Welcome } from './components/Welcome';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { SettingsDialog } from './components/SettingsDialog';
import { Rail } from './components/Rail';
import { StatusBar } from './components/StatusBar';
import type { RepoStats } from './types';
import { shortcut, useSettings } from './lib/settings';

interface Tab {
  id: number;
  path: string | null;
}

type WelcomeMode = 'home' | 'clone' | 'init';

// Shortens home-folder paths on macOS, Linux and Windows.
const tildify = (p: string) => p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');

const NON_TEXT_INPUTS = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'];
const isTextField = (el: Element | null) =>
  (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.includes(el.type)) ||
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLElement && el.isContentEditable);

function loadTabs(): { tabs: Tab[]; active: number } {
  try {
    const saved = JSON.parse(localStorage.getItem('tabs') ?? '');
    if (Array.isArray(saved.tabs) && saved.tabs.length) return saved;
  } catch {}
  return { tabs: [{ id: 1, path: null }], active: 1 };
}

// Applies the theme from Settings, following the OS when set to System.
function useTheme() {
  const { theme } = useSettings();
  useEffect(() => {
    api.setTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function Shell() {
  const ui = useUI();
  useTheme();
  const [{ tabs, active }, setState] = useState(loadTabs);
  const [welcomeMode, setWelcomeMode] = useState<WelcomeMode>('home');
  const [command, setCommand] = useState<{ name: string; n: number } | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState<RepoStats | null>(null);
  const settings = useSettings();
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
        if ((cmd === 'undo' || cmd === 'redo') && isTextField(document.activeElement)) {
          document.execCommand(cmd);
          return;
        }
        if (cmd === 'palette') {
          api.recent.get().then(setRecent);
          const { tabs, active } = stateRef.current;
          if (!tabs.find((t) => t.id === active)?.path) return setPaletteOpen(true);
        }
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
          case 'settings':
            return setSettingsOpen(true);
          default:
            setCommand({ name: cmd, n: Date.now() });
        }
      }),
    [newTab, openDialog, closeTab]
  );

  const repoMenu = async (e: React.MouseEvent) => {
    // Capture the button now: React clears currentTarget once the handler returns.
    const pos = { clientX: e.clientX, clientY: e.clientY, anchor: e.currentTarget };
    const recent = (await api.recent.get()).slice(0, 10);
    ui.menu(pos, [
      ...recent.map((p) => ({ label: basename(p), hint: tildify(p), onClick: () => openRepo(p) })),
      'sep' as const,
      { label: 'Open repository…', hint: shortcut('O'), onClick: openDialog },
      { label: 'Clone repository…', hint: shortcut('N'), onClick: () => newTab('clone') },
      { label: 'Init repository…', hint: shortcut('I'), onClick: () => newTab('init') },
    ]);
  };

  const activeTab = tabs.find((t) => t.id === active);

  const sendCommand = (name: string) => setCommand({ name, n: Date.now() });
  const openPalette = () => {
    api.recent.get().then(setRecent);
    if (activeTab?.path) sendCommand('palette');
    else setPaletteOpen(true);
  };
  const tabMenu = (e: React.MouseEvent, id: number) => {
    const t = tabs.find((x) => x.id === id);
    ui.menu(e, [
      ...(t?.path
        ? [
            { label: 'Show in folder', onClick: () => api.openPath(t.path!) },
            { label: 'Copy path', onClick: () => navigator.clipboard.writeText(t.path!) },
            'sep' as const,
          ]
        : []),
      { label: 'Close tab', hint: shortcut('W'), onClick: () => closeTab(id) },
    ]);
  };

  const appCommands: PaletteCommand[] = [
    ...tabs
      .filter((t) => t.id !== active)
      .map((t) => ({
        id: `tab:${t.id}`,
        group: 'Tab',
        label: `Switch to ${t.path ? basename(t.path) : 'New Tab'}`,
        run: () => setState((s) => ({ ...s, active: t.id })),
      })),
    ...recent
      .filter((p) => p !== activeTab?.path)
      .map((p) => ({ id: `recent:${p}`, group: 'Open', label: `Open ${basename(p)}`, hint: tildify(p), run: () => openRepo(p) })),
    { id: 'app:open', group: 'Repo', label: 'Open repository…', hint: shortcut('O'), run: openDialog },
    { id: 'app:clone', group: 'Repo', label: 'Clone repository…', hint: shortcut('N'), run: () => newTab('clone') },
    { id: 'app:init', group: 'Repo', label: 'Init repository…', hint: shortcut('I'), run: () => newTab('init') },
    { id: 'app:settings', group: 'App', label: 'Settings…', hint: shortcut(','), run: () => setSettingsOpen(true) },
    { id: 'app:new-tab', group: 'Tab', label: 'New tab', hint: shortcut('T'), run: () => newTab() },
    { id: 'app:close-tab', group: 'Tab', label: 'Close tab', hint: shortcut('W'), run: () => closeTab(active) },
  ];

  return (
    <div className={`app platform-${api.platform}`}>
      {api.platform === 'darwin' && <div className="titlebar">{activeTab?.path ? `${basename(activeTab.path)} — Gitline` : 'Gitline'}</div>}
      <div className="app-main">
        <Rail
          tabs={tabs}
          active={active}
          stats={activeTab?.path ? stats : null}
          onSelect={(id) => setState((st) => ({ ...st, active: id }))}
          onTabMenu={tabMenu}
          onClose={closeTab}
          onNew={() => newTab()}
          onView={sendCommand}
          onSearch={openPalette}
          onSettings={() => setSettingsOpen(true)}
          onEditor={() => activeTab?.path && api.openInEditor(activeTab.path, undefined, undefined, settings.editor).catch((e) => ui.toast(cleanError(e), 'error'))}
          onTerminal={() => activeTab?.path && api.openTerminal(activeTab.path)}
          onReveal={() => activeTab?.path && api.openPath(activeTab.path)}
        />
      <div className="app-body">
        {tabs.map((t) =>
          t.path ? (
            <RepoView
              key={t.id + t.path}
              path={t.path}
              active={t.id === active}
              command={t.id === active ? command : null}
              onRepoMenu={repoMenu}
              appCommands={appCommands}
              onOpenRepo={openRepo}
              onStats={setStats}
            />
          ) : null
        )}
        {activeTab && !activeTab.path && <Welcome onOpen={openRepo} mode={welcomeMode} setMode={setWelcomeMode} />}
        </div>
      </div>
      <StatusBar
        stats={activeTab?.path ? stats : null}
        onChanges={() => sendCommand('view-changes')}
        onUndo={() => sendCommand('undo')}
        onPalette={openPalette}
      />
      {paletteOpen && <CommandPalette commands={appCommands} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <SettingsDialog repo={activeTab?.path ?? null} onClose={() => setSettingsOpen(false)} />}
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
