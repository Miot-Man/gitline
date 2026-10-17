type Unsub = () => void;

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
  onRepoChanged(cb: (d: { path: string; gitChanged: boolean }) => void): Unsub;
  onMenu(cb: (cmd: string) => void): Unsub;
  onFocus(cb: () => void): Unsub;
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
