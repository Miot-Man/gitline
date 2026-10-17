type Unsub = () => void;

export type UpdateState =
  | { status: 'idle' | 'checking' | 'dev' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string; url: string } // can't self-install: link to the release
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

interface Api {
  platform: string;
  git(op: string, cwd: string, ...args: unknown[]): Promise<any>;
  openRepoDialog(): Promise<string | null>;
  pickFolder(title: string): Promise<string | null>;
  validateRepo(p: string): Promise<string | null>;
  recent: { get(): Promise<string[]>; add(p: string): Promise<void>; remove(p: string): Promise<void> };
  watch(p: string): Promise<void>;
  unwatch(p: string): Promise<void>;
  showItem(p: string): Promise<void>;
  openPath(p: string): Promise<void>;
  openTerminal(p: string): Promise<void>;
  openInEditor(repo: string, file?: string, line?: number, command?: string): Promise<void>;
  onRepoChanged(cb: (d: { path: string; gitChanged: boolean }) => void): Unsub;
  onMenu(cb: (cmd: string) => void): Unsub;
  onFocus(cb: () => void): Unsub;
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
  updates: {
    check(): Promise<void>;
    state(): Promise<UpdateState>;
    install(): Promise<void>;
    onChange(cb: (s: UpdateState) => void): Unsub;
  };
  version(): Promise<string>;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api = window.api;

export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim();
}

export function git<T = any>(op: string, cwd: string, ...args: unknown[]): Promise<T> {
  return api.git(op, cwd, ...args).catch((e) => {
    throw new Error(cleanError(e));
  });
}

export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const joinPath = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;
