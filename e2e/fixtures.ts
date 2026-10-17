import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');

export interface Gitline {
  app: ElectronApplication;
  page: Page;
  repo: string;
  git: (...args: string[]) => string;
  write: (file: string, content: string) => void;
  read: (file: string) => string;
  /** Sends an application-menu command, the same as picking it from the menu bar. */
  menu: (cmd: string) => Promise<void>;
  open: () => Promise<void>;
}

// Each test gets a fresh repo, a fresh profile and an isolated git config.
export const test = base.extend<{ gl: Gitline }>({
  gl: async ({}, use) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitline-e2e-')));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const gitconfig = path.join(root, 'gitconfig');
    fs.copyFileSync(path.join(APP_DIR, 'tests', 'gitconfig'), gitconfig);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string>;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    };
    const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
    git('init', '-q');

    const app = await electron.launch({
      args: [APP_DIR, `--user-data-dir=${path.join(root, 'profile')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      env,
    });
    const page = await app.firstWindow();
    // Test at the smallest allowed window so layouts are checked where space is tightest
    // (and results don't depend on the machine's screen size).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await page.waitForSelector('.app');
    const gl: Gitline = {
      app,
      page,
      repo,
      git,
      write,
      read,
      menu: (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c), cmd),
      open: async () => {
        await page.evaluate((r) => localStorage.setItem('tabs', JSON.stringify({ tabs: [{ id: 1, path: r }], active: 1 })), repo);
        await page.reload();
        await page.waitForSelector('.toolbar');
      },
    };
    await use(gl);
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  },
});

export { expect };

export const row = (page: Page, subject: string) => page.locator('.graph-row', { has: page.locator('.col-msg', { hasText: subject }) });
