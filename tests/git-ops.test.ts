import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLinePatch, parseDiff } from '../src/lib/diff';
import { headMove, type UndoEntry } from '../src/lib/undo';
import { cleanup, commitAll, ops, read, sh, subjects, tmpDir, tmpRepo, write } from './helpers';

afterAll(cleanup);

async function apply(dir: string, entry: UndoEntry, dirn: 'undo' | 'redo') {
  for (const s of entry[dirn]) await ops[s.op](dir, ...s.args);
}

describe('status, staging and commits', () => {
  it('stages, commits and reports status', async () => {
    const dir = await tmpRepo();
    write(dir, 'a.txt', 'one\n');
    expect((await ops.status(dir)).unstaged).toEqual([{ path: 'a.txt', status: '?' }]);
    await ops.stage(dir, ['a.txt']);
    expect((await ops.status(dir)).staged).toEqual([{ path: 'a.txt', status: 'A', oldPath: undefined }]);
    await ops.commit(dir, 'Add a', 'Body text');
    expect(sh(dir, 'log', '-1', '--format=%B')).toBe('Add a\n\nBody text');
    const info = await ops.info(dir);
    expect(info.branch).toBe('main');
  });

  it('shows untracked files as a diff', async () => {
    const dir = await tmpRepo();
    write(dir, 'new.txt', 'hello\n');
    expect(await ops.diffWorking(dir, 'new.txt', false, true)).toContain('+hello');
  });
});

describe('undo and redo', () => {
  it('undoes a commit keeping its changes staged, then redoes it', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '1\n');
    await commitAll(dir, 'first');
    write(dir, 'f', '2\n');
    await ops.stageAll(dir);
    const before = await ops.headState(dir);
    await ops.commit(dir, 'second');
    const after = await ops.headState(dir);
    const e = headMove('Commit', before, after, 'soft')!;
    await apply(dir, e, 'undo');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(before.head);
    expect((await ops.status(dir)).staged).toHaveLength(1);
    await apply(dir, e, 'redo');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(after.head);
  });

  it('restores a deleted annotated tag with its message', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '1\n');
    await commitAll(dir, 'first');
    await ops.createTag(dir, 'v1', 'HEAD', 'Release one');
    const tagSha = await ops.refSha(dir, 'refs/tags/v1');
    await ops.deleteTag(dir, 'v1');
    await ops.createRef(dir, 'refs/tags/v1', tagSha);
    expect(sh(dir, 'cat-file', '-t', 'v1')).toBe('tag');
    expect(sh(dir, 'tag', '-l', '-n1', 'v1')).toContain('Release one');
  });

  it('refuses to create a ref that already exists', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '1\n');
    const sha = await commitAll(dir, 'first');
    await expect(ops.createRef(dir, 'refs/heads/main', sha)).rejects.toThrow();
  });
});

describe('line staging', () => {
  it('stages, unstages and discards single lines', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', 'a\nb\nc\nd\ne\n');
    await commitAll(dir, 'init');
    write(dir, 'f', 'a\nB\nc\nD\ne\nnew\n');
    const pick = (text: string, staged: boolean) => async (lines: [string, 'add' | 'del'][]) => {
      const d = parseDiff(await ops.diffWorking(dir, 'f', staged, false));
      const h = d.hunks[0];
      const sel = new Set(lines.map(([t, type]) => h.lines.findIndex((l) => l.text === t && l.type === type)));
      return buildLinePatch(d.header, h, sel, text === 'reverse');
    };
    await ops.applyPatch(dir, await pick('forward', false)([['d', 'del'], ['D', 'add']]), true, false);
    expect(sh(dir, 'show', ':f')).toBe('a\nb\nc\nD\ne');
    await ops.applyPatch(dir, await pick('reverse', true)([['d', 'del'], ['D', 'add']]), true, true);
    expect(sh(dir, 'show', ':f')).toBe('a\nb\nc\nd\ne');
    await ops.applyPatch(dir, await pick('reverse', false)([['new', 'add']]), false, true);
    expect(read(dir, 'f')).toBe('a\nB\nc\nD\ne\n');
  });

  it('keeps line order when only part of a change block is staged', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', 'x\ny\nz\n');
    await commitAll(dir, 'init');
    write(dir, 'f', 'X\nY\nz\n');
    const d = parseDiff(await ops.diffWorking(dir, 'f', false, false));
    const h = d.hunks[0];
    const i = (t: string) => h.lines.findIndex((l) => l.text === t);
    await ops.applyPatch(dir, buildLinePatch(d.header, h, new Set([i('y'), i('Y')]), false), true, false);
    expect(sh(dir, 'show', ':f')).toBe('x\nY\nz');
  });
});

describe('interactive rebase', () => {
  it('rewords, fixes up and drops commits, keeping local edits', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '0\n');
    const base = await commitAll(dir, 'base');
    for (const n of [1, 2, 3]) {
      write(dir, `f${n}`, `${n}\n`);
      await commitAll(dir, `c${n}`);
    }
    write(dir, 'f', 'local edit\n');
    const plan = await ops.rebasePlan(dir, base);
    expect(plan.map((c: { message: string }) => c.message)).toEqual(['c1', 'c2', 'c3']);
    const r = await ops.interactiveRebase(dir, base, [
      { sha: plan[0].sha, action: 'reword', message: "c1 reworded with 'quotes' and $HOME" },
      { sha: plan[1].sha, action: 'fixup' },
      { sha: plan[2].sha, action: 'drop' },
    ]);
    expect(r.conflict).toBe(false);
    expect(subjects(dir)).toEqual(["c1 reworded with 'quotes' and $HOME", 'base']);
    expect(fs.existsSync(path.join(dir, 'f2'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'f3'))).toBe(false);
    expect(read(dir, 'f')).toBe('local edit\n');
  });

  it('rejects a base that is not an ancestor', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '0\n');
    await commitAll(dir, 'base');
    await ops.createBranch(dir, 'side', undefined, true);
    write(dir, 'g', '1\n');
    const side = await commitAll(dir, 'side');
    await ops.checkout(dir, 'main');
    await expect(ops.rebasePlan(dir, side)).rejects.toThrow(/ancestor/);
  });
});

describe('history tools', () => {
  it('follows a file across renames and blames lines', async () => {
    const dir = await tmpRepo();
    write(dir, 'old.txt', 'a\nb\n');
    await commitAll(dir, 'add');
    fs.renameSync(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
    await commitAll(dir, 'rename');
    write(dir, 'new.txt', 'a\nB\n');
    await commitAll(dir, 'edit');
    const log = await ops.fileLog(dir, 'new.txt');
    expect(log.map((e: { subject: string }) => e.subject)).toEqual(['edit', 'rename', 'add']);
    expect(log[1].file).toMatchObject({ status: 'R', oldPath: 'old.txt', path: 'new.txt' });
    const blame = await ops.blame(dir, 'new.txt');
    expect(blame.lines.map((l: { sha: string }) => blame.commits[l.sha].summary)).toEqual(['add', 'edit']);
  });

  it('searches diffs and paths, and filters the log', async () => {
    const dir = await tmpRepo();
    write(dir, 'src/config.ts', 'export const apiToken = 1;\n');
    await commitAll(dir, 'config');
    write(dir, 'readme.md', 'hi\n');
    await commitAll(dir, 'readme');
    await ops.createBranch(dir, 'side', undefined, true);
    write(dir, 'side.txt', 's\n');
    await commitAll(dir, 'side work');
    await ops.checkout(dir, 'main');
    expect(await ops.searchCommits(dir, 'changes', 'apitoken')).toHaveLength(1);
    expect(await ops.searchCommits(dir, 'path', 'CONFIG')).toHaveLength(1);
    expect(await ops.log(dir, 100, { hidden: ['refs/heads/side'] })).toHaveLength(2);
    expect(await ops.log(dir, 100, { solo: ['refs/heads/side'] })).toHaveLength(3);
    expect(await ops.log(dir, 100, { solo: ['refs/heads/missing'] })).toHaveLength(2);
  });
});

describe('remotes and teammates', () => {
  it('reports commits other people pushed, once', async () => {
    const root = tmpDir();
    const origin = path.join(root, 'origin.git');
    sh(root, 'init', '-q', '--bare', origin);
    const me = path.join(root, 'me');
    const mate = path.join(root, 'mate');
    sh(root, 'clone', '-q', origin, me);
    write(me, 'a', '1\n');
    await commitAll(me, 'init');
    sh(me, 'push', '-q', '-u', 'origin', 'main');
    sh(root, 'clone', '-q', origin, mate);
    sh(mate, 'config', 'user.name', 'Nathan');
    sh(mate, 'config', 'user.email', 'nathan@example.com');
    write(mate, 'a', '2\n');
    await commitAll(mate, 'mate 1');
    sh(mate, 'push', '-q', 'origin', 'main');
    sh(mate, 'checkout', '-q', '-b', 'feature');
    write(mate, 'f', 'f\n');
    await commitAll(mate, 'feature');
    sh(mate, 'push', '-q', 'origin', 'feature');

    const report = await ops.fetch(me);
    expect(report).toEqual(
      expect.arrayContaining([
        { ref: 'origin/main', count: 1, authors: ['Nathan'], isNew: false },
        { ref: 'origin/feature', count: 1, authors: ['Nathan'], isNew: true },
      ])
    );
    expect(await ops.fetch(me)).toEqual([]);

    // A branch deleted on the remote shows up as "gone" for stale-branch cleanup.
    sh(me, 'checkout', '-q', '-b', 'feature', '--track', 'origin/feature');
    sh(me, 'checkout', '-q', 'main');
    sh(mate, 'push', '-q', 'origin', '--delete', 'feature');
    await ops.fetch(me);
    const refs = await ops.refs(me);
    expect(refs.find((r: { name: string }) => r.name === 'feature').track).toBe('gone');
  });
});

describe('merge conflicts', () => {
  it('reads, resolves and stages a conflicted file', async () => {
    const dir = await tmpRepo();
    write(dir, 'c.txt', 'speed = 100\n');
    await commitAll(dir, 'base');
    await ops.createBranch(dir, 'tune', undefined, true);
    write(dir, 'c.txt', 'speed = 120\n');
    await commitAll(dir, 'tune');
    await ops.checkout(dir, 'main');
    write(dir, 'c.txt', 'speed = 80\n');
    await commitAll(dir, 'slow');
    const r = await ops.merge(dir, 'tune');
    expect(r.conflict).toBe(true);
    expect(await ops.readFile(dir, 'c.txt')).toContain('<<<<<<<');
    await ops.writeFile(dir, 'c.txt', 'speed = 90\n');
    await ops.stage(dir, ['c.txt']);
    expect((await ops.status(dir)).conflicted).toHaveLength(0);
    await ops.continueOp(dir, 'merge');
    expect(read(dir, 'c.txt')).toBe('speed = 90\n');
    expect(sh(dir, 'log', '-1', '--format=%p').split(' ')).toHaveLength(2);
  });

  it('refuses file access outside the repo', async () => {
    const dir = await tmpRepo();
    for (const bad of ['../x', path.resolve(dir, '..', 'x'), '.']) await expect(ops.readFile(dir, bad)).rejects.toThrow(/outside/);
  });
});

describe('worktrees, submodules, LFS and ignored files', () => {
  it('adds, lists and removes worktrees', async () => {
    const dir = await tmpRepo();
    write(dir, 'f', '1\n');
    await commitAll(dir, 'init');
    await ops.createBranch(dir, 'feature', undefined, false);
    const wt = path.join(tmpDir(), 'feature-wt');
    await ops.addWorktree(dir, wt, 'feature');
    const list = await ops.worktrees(dir);
    expect(list).toHaveLength(2);
    expect(list.find((w: { current: boolean }) => !w.current).branch).toBe('feature');
    await ops.removeWorktree(dir, wt, false);
    expect(await ops.worktrees(dir)).toHaveLength(1);
  });

  it('reports submodule state', async () => {
    const lib = await tmpRepo();
    write(lib, 'x', '1\n');
    await commitAll(lib, 'lib');
    const dir = await tmpRepo();
    write(dir, 'f', '1\n');
    await commitAll(dir, 'init');
    sh(dir, 'submodule', 'add', '-q', lib, 'vendor/lib');
    sh(dir, 'commit', '-qm', 'add submodule');
    expect(await ops.submodules(dir)).toMatchObject([{ path: 'vendor/lib', state: 'ok' }]);
    sh(dir, 'submodule', 'deinit', '-q', '-f', 'vendor/lib');
    expect(await ops.submodules(dir)).toMatchObject([{ path: 'vendor/lib', state: 'uninitialized' }]);
    await ops.updateSubmodules(dir, 'vendor/lib');
    expect(await ops.submodules(dir)).toMatchObject([{ state: 'ok' }]);
  });

  it('detects LFS use from .gitattributes', async () => {
    const dir = await tmpRepo();
    expect((await ops.lfsInfo(dir)).used).toBe(false);
    write(dir, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    expect((await ops.lfsInfo(dir)).used).toBe(true);
  });

  it('lists ignored folders once', async () => {
    const dir = await tmpRepo();
    write(dir, '.gitignore', 'build/\n*.log\n');
    write(dir, 'build/a/b.bin', 'x');
    write(dir, 'build/c.bin', 'x');
    write(dir, 'run.log', 'x');
    expect((await ops.ignoredFiles(dir)).sort()).toEqual(['build/', 'run.log']);
  });
});

describe('images and config', () => {
  it('returns image data for each side of a change', async () => {
    const dir = await tmpRepo();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(dir, 'p.png'), png);
    await commitAll(dir, 'image');
    const committed = await ops.imageData(dir, 'HEAD', 'p.png');
    expect(committed.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(committed.size).toBe(png.length);
    expect(await ops.imageData(dir, null, 'p.png')).toEqual(committed);
    expect(await ops.imageData(dir, 'HEAD', 'missing.png')).toBeNull();
    expect(await ops.imageData(dir, 'HEAD', 'notes.txt')).toBeNull();
  });

  it('reads the commit template and repo config', async () => {
    const dir = await tmpRepo();
    expect(await ops.commitTemplate(dir)).toBeNull();
    write(dir, '.tmpl', '# hint\n[area] \n');
    await ops.setConfig(dir, 'commit.template', '.tmpl', 'local');
    expect(await ops.commitTemplate(dir)).toBe('# hint\n[area] \n');
    expect(await ops.getConfig(dir, 'user.email')).toBe('test@example.com');
  });
});
