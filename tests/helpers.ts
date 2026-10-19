import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const { ops } = require('../electron/git.cjs') as { ops: Record<string, (...args: any[]) => Promise<any>> };

const made: string[] = [];

export function tmpDir(prefix = 'gitline-test-') {
  // Real path, as git sees it: macOS reports /private/var for /var, and Windows temp folders can come back
  // as 8.3 short names (RUNNER~1) that git resolves to the long form.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanup() {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export async function tmpRepo() {
  const dir = tmpDir();
  await ops.init(dir);
  return dir;
}

export const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
export const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

export const sh = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

export async function commitAll(dir: string, message: string) {
  await ops.stageAll(dir);
  await ops.commit(dir, message);
  return sh(dir, 'rev-parse', 'HEAD');
}

export const subjects = (dir: string, rev = 'HEAD') => sh(dir, 'log', '--format=%s', rev).split('\n');
