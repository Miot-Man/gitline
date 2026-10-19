import fs from 'node:fs';
import path from 'node:path';
import { expect, row, test } from './fixtures';

test('commit from the staging panel, then undo and redo it', async ({ gl }) => {
  const { page } = gl;
  gl.write('notes.txt', 'one\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();
  gl.write('notes.txt', 'one\ntwo\n');

  // A commit is selected when the repo opens; switch to the working changes.
  await row(page, 'uncommitted change').click();
  await page.getByRole('button', { name: 'Stage all changes' }).click();
  await page.locator('.summary').fill('Add line two');
  await page.locator('.btn-commit').click();
  await expect(row(page, 'Add line two')).toBeVisible();
  expect(gl.git('log', '-1', '--format=%s')).toBe('Add line two');

  // At the smallest window the header hides Undo/Redo; the status bar and the Edit menu still have them.
  await page.locator('.statusbar').getByRole('button', { name: /^Undo: Commit "Add line two"/ }).click();
  await expect(row(page, 'Add line two')).toHaveCount(0);
  expect(gl.git('log', '-1', '--format=%s')).toBe('Initial');
  expect(gl.git('diff', '--cached', '--name-only')).toBe('notes.txt');

  await gl.menu('redo');
  await expect(row(page, 'Add line two')).toBeVisible();
});

test('command palette creates a branch', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', 'a\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();

  await gl.menu('palette');
  await page.locator('.palette input').fill('create branch');
  await page.keyboard.press('Enter');
  await page.locator('.modal input').fill('feature/login');
  await page.keyboard.press('Enter');
  await expect(page.locator('.trail-branch', { hasText: 'feature/login' })).toBeVisible();
  expect(gl.git('symbolic-ref', '--short', 'HEAD')).toBe('feature/login');
});

test('theme can be switched in Settings', async ({ gl }) => {
  const { page } = gl;
  // Saving also writes git config, so wait for the dialog to close before reopening it.
  const setTheme = async (theme: string) => {
    await gl.menu('settings');
    await page.locator('.settings-modal select').first().selectOption(theme);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.settings-modal')).toHaveCount(0);
  };
  for (const theme of ['dark', 'light', 'dark']) {
    await setTheme(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
});

test('stage a single line from the diff view', async ({ gl }) => {
  const { page } = gl;
  gl.write('lines.txt', 'a\nb\nc\nd\ne\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();
  gl.write('lines.txt', 'a\nB\nc\nd\nE\n');

  await row(page, 'uncommitted change').click();
  await page.locator('.staging .file-row', { hasText: 'lines.txt' }).click();
  const line = (text: string, cls: string) => page.locator(`tr.${cls}`, { has: page.locator('td.code', { hasText: new RegExp(`^.${text}$`) }) }).locator('td.ln').first();
  await line('b', 'dl-del').click();
  await line('B', 'dl-add').click();
  await page.getByRole('button', { name: 'Stage 2 lines' }).click();
  await expect.poll(() => gl.git('show', ':lines.txt')).toBe('a\nB\nc\nd\ne');
});

test('resolve a merge conflict in the conflict editor', async ({ gl }) => {
  const { page } = gl;
  gl.write('config.txt', 'speed = 100\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'tuning');
  gl.write('config.txt', 'speed = 120\n');
  gl.git('commit', '-qam', 'Tune');
  gl.git('checkout', '-q', 'main');
  gl.write('config.txt', 'speed = 80\n');
  gl.git('commit', '-qam', 'Slow');
  try {
    gl.git('merge', 'tuning');
  } catch {
    // expected: conflict
  }
  await gl.open();

  // Click the name: the conflicted row also has its own Ours/Theirs buttons.
  await page.locator('.file-row', { hasText: 'config.txt' }).locator('.file-name').click();
  await page.locator('.conflict-card .seg button', { hasText: /^Incoming$/ }).click();
  await page.getByRole('button', { name: 'Save & Mark Resolved' }).click();
  await expect(page.locator('.btn-commit')).toHaveText('Commit merge');
  await page.locator('.btn-commit').click();
  await expect.poll(() => gl.git('log', '-1', '--format=%p').split(' ').length).toBe(2);
  expect(gl.read('config.txt')).toBe('speed = 120\n');
});

test('a rebase conflict names your commit and upstream, and keeps your change', async ({ gl }) => {
  const { page } = gl;
  gl.write('config.txt', 'speed = 100\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'mine');
  gl.write('config.txt', 'speed = 120\n');
  gl.git('commit', '-qam', 'My change');
  gl.git('checkout', '-q', 'main');
  gl.write('config.txt', 'speed = 80\n');
  gl.git('commit', '-qam', 'Upstream change');
  gl.git('checkout', '-q', 'mine');
  try {
    gl.git('rebase', 'main');
  } catch {
    // expected: conflict
  }
  await gl.open();

  const conflicted = page.locator('.file-row', { hasText: 'config.txt' });
  await expect(conflicted.locator('.file-kind')).toHaveText('both modified');
  await conflicted.hover();
  await expect(conflicted.getByRole('button', { name: 'Upstream' })).toHaveAttribute('title', /Upstream \(main\)/);
  await expect(conflicted.getByRole('button', { name: 'Your commit' })).toHaveAttribute('title', /My change/);
  await expect(page.locator('.state-banner')).toContainText('Applying your commit');

  // Taking upstream for the whole file asks first, since it drops your change.
  await conflicted.getByRole('button', { name: 'Upstream' }).click();
  await expect(page.locator('.modal')).toContainText("This drops your commit's changes to config.txt.");
  await page.getByRole('button', { name: 'Cancel' }).click();

  await conflicted.locator('.file-name').click();
  await expect(page.locator('.conflict-side.ours .conflict-label')).toHaveText('Upstream');
  await expect(page.locator('.conflict-side.theirs .conflict-label')).toHaveText('Your commit');
  await page.locator('.conflict-card .seg button', { hasText: /^Your commit$/ }).click();
  await page.getByRole('button', { name: 'Save & Mark Resolved' }).click();
  await page.locator('.state-banner').getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.state-banner')).toHaveCount(0);
  expect(gl.read('config.txt')).toBe('speed = 120\n');
  expect(gl.git('log', '--format=%s').split('\n')).toEqual(['My change', 'Upstream change', 'Base']);
});

test('a modify/delete conflict is resolved by deleting the file', async ({ gl }) => {
  const { page } = gl;
  gl.write('keep.txt', 'keep\n');
  gl.write('old.txt', 'old\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'cleanup');
  gl.git('rm', '-q', 'old.txt');
  gl.git('commit', '-qm', 'Remove old');
  gl.git('checkout', '-q', 'main');
  gl.write('old.txt', 'old, edited\n');
  gl.git('commit', '-qam', 'Edit old');
  try {
    gl.git('merge', 'cleanup');
  } catch {
    // expected: conflict
  }
  await gl.open();

  const conflicted = page.locator('.file-row', { hasText: 'old.txt' });
  await expect(conflicted.locator('.file-kind')).toHaveText('deleted by incoming');
  await conflicted.locator('.file-name').click();
  await expect(page.locator('.conflict-side.ours')).toContainText('Changed the file');
  await expect(page.locator('.conflict-side.theirs')).toContainText('Deleted the file');
  await expect(page.locator('.conflict-surviving')).toHaveText('old, edited\n');
  await page.locator('.conflict-editor').getByRole('button', { name: 'Delete file' }).click();
  await expect(page.locator('.btn-commit')).toHaveText('Commit merge');
  await page.locator('.btn-commit').click();
  await expect.poll(() => gl.git('log', '-1', '--format=%p').split(' ').length).toBe(2);
  expect(gl.git('ls-files')).toBe('keep.txt');
});

test('a conflicting stash pop gets a banner and ends with its changes unstaged', async ({ gl }) => {
  const { page } = gl;
  gl.write('config.txt', 'speed = 100\n');
  gl.write('notes.txt', 'notes\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.write('config.txt', 'speed = 120\n');
  gl.write('notes.txt', 'more notes\n');
  gl.git('stash', '-q');
  gl.write('config.txt', 'speed = 80\n');
  gl.git('commit', '-qam', 'Slow');
  await gl.open();

  // The palette only lists stashes once they have loaded (slower on Windows).
  await expect(page.locator('.sidebar', { hasText: 'WIP on main' })).toBeVisible();
  await gl.menu('palette');
  await page.locator('.palette input').fill('pop stash@{0}');
  await expect(page.locator('.palette-item.active')).toContainText('Pop stash@{0}');
  await page.keyboard.press('Enter');
  await expect(page.locator('.state-banner')).toContainText('Popping stash@{0} hit conflicts');
  const conflicted = page.locator('.file-row', { hasText: 'config.txt' });
  await conflicted.hover();
  await conflicted.getByRole('button', { name: 'Stash' }).click();
  await expect(page.locator('.state-banner')).toHaveCount(0);
  await expect.poll(() => gl.git('status', '--porcelain')).toBe('M config.txt\n M notes.txt');
  expect(gl.read('config.txt')).toBe('speed = 120\n');
  // Newer git fails `stash list` once the last stash is gone, so ask for the ref instead.
  const hasStash = () => gl.git('for-each-ref', 'refs/stash') !== '';
  expect(hasStash()).toBe(true);
  await page.locator('.toast').getByRole('button', { name: 'Drop the stash' }).click();
  await expect.poll(hasStash).toBe(false);
});

test('with diff3 markers the conflict card shows the original version', async ({ gl }) => {
  const { page } = gl;
  gl.git('config', 'merge.conflictStyle', 'diff3');
  gl.write('config.txt', 'speed = 100\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'tuning');
  gl.write('config.txt', 'speed = 120\n');
  gl.git('commit', '-qam', 'Tune');
  gl.git('checkout', '-q', 'main');
  gl.write('config.txt', 'speed = 80\n');
  gl.git('commit', '-qam', 'Slow');
  try {
    gl.git('merge', 'tuning');
  } catch {
    // expected: conflict
  }
  await gl.open();

  await page.locator('.file-row', { hasText: 'config.txt' }).locator('.file-name').click();
  const original = page.locator('.conflict-base');
  await expect(original.locator('.conflict-label')).toHaveText('Original');
  await expect(original.locator('.conflict-code')).toHaveText('speed = 100');
  await original.locator('.conflict-label').click();
  await expect(original.locator('.conflict-code')).toHaveCount(0);
  await page.locator('.conflict-card .seg button', { hasText: /^Current branch$/ }).click();
  await expect(page.locator('.conflict-result textarea')).toHaveValue('speed = 80\n');
});

test('conflict cards show context, line numbers, syntax and changed words, and step between conflicts', async ({ gl }) => {
  const { page } = gl;
  const lines = (speed: string, turn: string) =>
    ['#include <stdio.h>', '', 'int a = 1;', 'int b = 2;', 'int c = 3;', `int speed = ${speed};`, 'int d = 4;', 'int e = 5;', 'int f = 6;', 'int g = 7;', `int turn = ${turn};`, 'int h = 8;', ''].join('\n');
  gl.write('main.c', lines('100', '30'));
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'tuning');
  gl.write('main.c', lines('120', '35'));
  gl.git('commit', '-qam', 'Tune');
  gl.git('checkout', '-q', 'main');
  gl.write('main.c', lines('80', '25'));
  gl.git('commit', '-qam', 'Slow');
  try {
    gl.git('merge', 'tuning');
  } catch {
    // expected: conflict
  }
  await gl.open();

  await page.locator('.file-row', { hasText: 'main.c' }).locator('.file-name').click();
  const cards = page.locator('.conflict-card');
  await expect(cards).toHaveCount(2);
  const first = cards.nth(0);
  // Three unchanged lines above and below, numbered as in the file.
  await expect(first.locator('.conflict-code.before .cl')).toHaveCount(3);
  await expect(first.locator('.conflict-code.before .cl').first()).toHaveText('3int a = 1;');
  await expect(first.locator('.conflict-code.after .cl').first()).toHaveText('11int d = 4;');
  // Undecided, the result still holds the markers: ours is line 7, theirs line 9.
  await expect(first.locator('.conflict-code.ours .cl-no')).toHaveText('7');
  await expect(first.locator('.conflict-code.theirs .cl-no')).toHaveText('9');
  await expect(first.locator('.conflict-code.ours .hljs-type, .conflict-code.ours .hljs-keyword').first()).toBeVisible();
  await expect(first.locator('.conflict-code.ours .wd')).toHaveText('80');
  await expect(first.locator('.conflict-code.theirs .wd')).toHaveText('120');

  // Choosing a side renumbers what follows.
  await first.locator('.seg button', { hasText: /^Incoming$/ }).click();
  await expect(first.locator('.conflict-code.theirs .cl-no')).toHaveText('6');
  await expect(first.locator('.conflict-code.after .cl').first()).toHaveText('7int d = 4;');

  // Next / previous move the current card.
  await expect(first).toHaveClass(/current/);
  await page.getByRole('button', { name: 'Next conflict' }).click();
  await expect(cards.nth(1)).toHaveClass(/current/);
  await expect(cards.nth(1)).toBeInViewport();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(first).toHaveClass(/current/);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(cards.nth(1)).toHaveClass(/current/);
  // Still in the conflict editor: Alt+arrows don't step to another file.
  await expect(page.locator('.conflict-editor')).toBeVisible();

  await cards.nth(1).locator('.seg button', { hasText: /^Current branch$/ }).click();
  await expect(page.locator('.conflict-result textarea')).toHaveValue(lines('120', '25'));
});

test('choosing a side scrolls the result to that conflict', async ({ gl }) => {
  const { page } = gl;
  const file = (top: string, bottom: string) => [top, ...Array.from({ length: 80 }, (_, i) => `line ${i}`), bottom, ''].join('\n');
  gl.write('long.txt', file('top', 'bottom'));
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.git('checkout', '-qb', 'other');
  gl.write('long.txt', file('top theirs', 'bottom theirs'));
  gl.git('commit', '-qam', 'Theirs');
  gl.git('checkout', '-q', 'main');
  gl.write('long.txt', file('top ours', 'bottom ours'));
  gl.git('commit', '-qam', 'Ours');
  try {
    gl.git('merge', 'other');
  } catch {
    // expected: conflict
  }
  await gl.open();

  await page.locator('.file-row', { hasText: 'long.txt' }).locator('.file-name').click();
  const result = page.locator('.conflict-result textarea');
  const scrollTop = () => result.evaluate((el) => el.scrollTop);
  await page.locator('.conflict-card').nth(1).locator('.seg button', { hasText: /^Incoming$/ }).click();
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  await page.locator('.conflict-card').nth(0).locator('.seg button', { hasText: /^Incoming$/ }).click();
  await expect.poll(scrollTop).toBe(0);
});

test('a runaway commit title or body stays contained, and the message can be edited', async ({ gl }) => {
  const { page } = gl;
  const words = 'lorem ipsum dolor sit amet '.repeat(2000).trim();
  gl.write('f.txt', '0\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  // Messages go in through a file (outside the repo): as arguments they'd pass Windows' 32 KB command-line limit.
  const msg = path.join(gl.repo, '..', 'msg.txt');
  const commit = (m: string) => {
    fs.writeFileSync(msg, m);
    gl.git('commit', '-qa', '-F', msg);
  };
  gl.write('f.txt', '1\n');
  commit(words);
  gl.write('f.txt', '2\n');
  commit(`After\n\n${words}\n\n${'x'.repeat(5000)}`);
  await gl.open();

  // A runaway body scrolls in its own box and wraps even unbroken strings.
  await row(page, 'After').click();
  await expect(page.locator('.commit-body')).toBeVisible();
  await expect(page.locator('.commit-author')).toBeInViewport();
  expect(await page.locator('.commit-body').evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);

  await row(page, 'lorem ipsum').click();
  await expect(page.locator('.commit-subject.clamped')).toBeVisible();
  // The author and files stay in view under the collapsed title.
  await expect(page.locator('.commit-author')).toBeInViewport();
  await page.locator('.subject-toggle', { hasText: 'Show all 10,000 words' }).click();
  await expect(page.locator('.commit-subject.scroll')).toBeVisible();

  await row(page, 'lorem ipsum').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Edit commit message' }).click();
  await page.locator('.modal textarea').fill('Fix the thing');
  await page.locator('.modal').getByRole('button', { name: 'Save Message' }).click();
  await expect(row(page, 'Fix the thing')).toBeVisible();
  expect(gl.git('log', '--format=%s').split('\n')).toEqual(['After', 'Fix the thing', 'Base']);
  // Rewording an older commit keeps the later commits' messages intact.
  expect(gl.git('log', '-1', '--format=%b')).toContain('x'.repeat(5000));
});

test('interactive rebase fixes up a commit', async ({ gl }) => {
  const { page } = gl;
  gl.write('f.txt', '0\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Base');
  gl.write('f.txt', '1\n');
  gl.git('commit', '-qam', 'Feature');
  gl.write('f.txt', '2\n');
  gl.git('commit', '-qam', 'Fix typo');
  await gl.open();

  await row(page, 'Base').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Interactive rebase' }).click();
  await page.locator('.rebase-row', { hasText: 'Fix typo' }).getByRole('button', { name: 'Fixup' }).click();
  await page.getByRole('button', { name: 'Start Rebase' }).click();
  await expect(row(page, 'Fix typo')).toHaveCount(0);
  expect(gl.git('log', '--format=%s').split('\n')).toEqual(['Feature', 'Base']);
  expect(gl.read('f.txt')).toBe('2\n');
});

test('dropdowns close when their button is clicked again', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', 'a\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();

  const branchButton = page.locator('.trail-branch');
  const menu = page.locator('.context-menu');
  await branchButton.click();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Create new branch');
  await branchButton.click();
  await expect(menu).toHaveCount(0);
  await branchButton.click();
  await expect(menu).toBeVisible();

  // Opening a different dropdown swaps menus instead of needing two clicks.
  await page.locator('.split-caret').click();
  await expect(menu).toContainText('Fetch All');
  await expect(menu).not.toContainText('Create new branch');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // The repository menu loads recent repos before opening; it toggles the same way.
  const repoButton = page.locator('.side-title-btn');
  await repoButton.click();
  await expect(menu).toContainText('Open repository');
  await repoButton.click();
  await expect(menu).toHaveCount(0);
});

test('opening a file diff shows a trail, arrow keys step files, back returns', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', 'a\n');
  gl.write('b.txt', 'b\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Two files');
  await gl.open();

  await row(page, 'Two files').click();
  await page.locator('.commit-panel .file-row', { hasText: 'a.txt' }).click();
  const trail = page.locator('.trail');
  await expect(trail).toContainText('a.txt');
  await page.keyboard.press('ArrowDown');
  await expect(trail).toContainText('b.txt');
  await expect(page.locator('.commit-panel .file-row.active')).toContainText('b.txt');
  await page.getByRole('button', { name: 'Back to history' }).click();
  await expect(row(page, 'Two files')).toBeVisible();
  await expect(page.locator('.trail-branch')).toBeVisible();
});

test('branch selector lists remote branches and checks them out', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', 'a\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  gl.git('init', '-q', '--bare', '../origin.git');
  gl.git('remote', 'add', 'origin', '../origin.git');
  gl.git('push', '-q', 'origin', 'main');
  gl.git('checkout', '-qb', 'feature/remote-only');
  gl.git('push', '-q', 'origin', 'feature/remote-only');
  gl.git('checkout', '-q', 'main');
  gl.git('branch', '-q', '-D', 'feature/remote-only');
  await gl.open();

  // Wait until the repo has loaded its remote branches before opening the menu.
  await expect(page.locator('.side-item', { hasText: 'remote-only' })).toBeVisible();
  await page.locator('.trail-branch').click();
  await expect(page.locator('.context-menu')).toBeVisible();
  const item = page.locator('.context-menu .menu-item', { hasText: 'origin/feature/remote-only' });
  await expect(item.locator('.menu-icon svg')).toBeVisible();
  await item.click();
  await expect(page.locator('.trail-branch', { hasText: 'feature/remote-only' })).toBeVisible();
  expect(gl.git('rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/remote-only');
});

test('diffs highlight syntax and changed words, and can ignore whitespace', async ({ gl }) => {
  const { page } = gl;
  gl.write('main.c', 'int speed = 100;\nint turn = 35;\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();
  gl.write('main.c', 'int speed = 120;\n    int turn = 35;\n');

  await row(page, 'uncommitted change').click();
  await page.locator('.staging .file-row', { hasText: 'main.c' }).locator('.file-name').click();
  await expect(page.locator('.diff-table .hljs-type, .diff-table .hljs-keyword').first()).toBeVisible();
  await expect(page.locator('.diff-table .dl-add .wd', { hasText: '120' })).toBeVisible();
  await expect(page.locator('.diff-table .dl-add', { hasText: 'int turn = 35;' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Ignore whitespace' }).click();
  await expect(page.locator('.diff-table .dl-add', { hasText: 'int turn = 35;' })).toHaveCount(0);
  await expect(page.locator('.diff-table .dl-add', { hasText: '120' })).toHaveCount(1);
  // Hunk staging is off while whitespace is ignored.
  await expect(page.getByRole('button', { name: 'Stage Hunk' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ignore whitespace' }).click();
  await expect(page.getByRole('button', { name: 'Stage Hunk' })).toHaveCount(1);
});

test('bisect walks to the first bad commit', async ({ gl }) => {
  const { page } = gl;
  for (let i = 1; i <= 6; i++) {
    gl.write('speed.txt', i >= 4 ? `broken ${i}\n` : `ok ${i}\n`);
    gl.git('add', '.');
    gl.git('commit', '-qm', `Step ${i}`);
  }
  await gl.open();

  await row(page, 'Step 1').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Bisect: this commit was good' }).click();
  const banner = page.locator('.bisect-banner');
  await expect(banner).toContainText('Bisecting');
  for (let n = 0; n < 6; n++) {
    if (await banner.locator('text=First bad commit').count()) break;
    const broken = gl.read('speed.txt').startsWith('broken');
    await banner.getByRole('button', { name: broken ? 'Bad' : 'Good', exact: true }).click();
    await page.waitForTimeout(300);
  }
  await expect(banner).toContainText('First bad commit');
  await expect(banner).toContainText('Step 4');
  await banner.getByRole('button', { name: 'Finish' }).click();
  await expect(banner).toHaveCount(0);
  expect(gl.git('symbolic-ref', '--short', 'HEAD')).toBe('main');
});

test('shortcuts list and .gitignore editor', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', 'a\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();

  await gl.menu('shortcuts');
  await expect(page.locator('.shortcuts-modal')).toContainText('Search and run commands');
  await page.getByRole('button', { name: 'Done' }).click();

  await gl.menu('palette');
  await page.locator('.palette input').fill('gitignore');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '+ Node' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => gl.read('.gitignore')).toContain('node_modules/');
});

test('picking a language in a diff remembers it for that file type', async ({ gl }) => {
  const { page } = gl;
  gl.write('game.p8', 'x = 1\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  await gl.open();
  gl.write('game.p8', 'local x = 2\n');

  await row(page, 'uncommitted change').click();
  await page.locator('.staging .file-row', { hasText: 'game.p8' }).locator('.file-name').click();
  const picker = page.getByRole('combobox', { name: 'Syntax highlighting language' });
  await expect(picker).toHaveValue('none');
  await picker.selectOption('lua');
  await expect(page.locator('.diff-table .hljs-keyword', { hasText: 'local' })).toBeVisible();
  const rules = await page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}').syntaxRules);
  expect(rules).toEqual([{ pattern: '.p8', language: 'lua' }]);
});

test('home lists recent repos, and clones from a URL into the remembered folder', async ({ gl }) => {
  const { page } = gl;
  const root = path.dirname(gl.repo);
  gl.write('a.txt', '1\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  gl.git('init', '-q', '--bare', '../origin.git');
  gl.git('remote', 'add', 'origin', '../origin.git');
  gl.git('push', '-q', '-u', 'origin', 'main');
  gl.write('b.txt', '2\n');
  fs.writeFileSync(path.join(root, 'profile', 'recent.json'), JSON.stringify([gl.repo]));
  await page.evaluate((p) => localStorage.setItem('cloneParent', p), root);
  await page.reload();

  const repoRow = page.locator('.repo-row').filter({ hasText: 'main' });
  await expect(repoRow).toContainText('repo');
  await expect(repoRow).toContainText('1 change');
  await page.getByRole('textbox', { name: 'Filter repositories' }).fill('nothing-like-it');
  await expect(page.locator('.repo-none')).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter repositories' }).fill('');

  await page.getByRole('button', { name: 'Clone…' }).click();
  await page.getByRole('tab', { name: 'URL' }).click();
  await page.getByRole('textbox', { name: 'Repository URL' }).fill(path.join(root, 'origin.git'));
  await expect(page.getByRole('textbox', { name: 'Folder name' })).toHaveValue('origin');
  await page.getByRole('textbox', { name: 'Folder name' }).fill('copy');
  await page.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  expect(fs.existsSync(path.join(root, 'copy', 'a.txt'))).toBe(true);
});

test('a pull request opens in the side panel, where you can comment, review and merge it', async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', '1\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  gl.git('checkout', '-qb', 'feature/login');
  gl.write('login.txt', 'form\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Add login page');
  const sha = gl.git('rev-parse', 'HEAD');
  gl.git('checkout', '-q', 'main');
  gl.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  const pr = {
    number: 7,
    title: 'Add login',
    headRefName: 'feature/login',
    headRefOid: sha,
    baseRefName: 'main',
    author: { login: 'mate' },
    url: 'https://github.com/example/repo/pull/7',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'Test (ubuntu)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' }],
    isCrossRepository: false,
  };
  gl.setGh({
    user: 'me',
    prs: [pr],
    pr: {
      ...pr,
      body: '## Why\nPeople asked for **login**.',
      state: 'OPEN',
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-02T10:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewRequests: [{ __typename: 'User', login: 'sam' }],
      reviews: [{ author: { login: 'ana' }, state: 'APPROVED', body: 'Nice', submittedAt: '2026-10-01T12:00:00Z' }],
      comments: [{ author: { login: 'sam' }, body: 'Will look tomorrow', createdAt: '2026-10-01T10:30:00Z', url: '' }],
      commits: [{}],
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
  });
  await gl.open();

  await page.locator('.pr-item', { hasText: 'Add login' }).click();
  const panel = page.locator('.pr-panel');
  await expect(panel.locator('.pr-title')).toContainText('Add login');
  await expect(panel.locator('.markdown h2')).toHaveText('Why');
  await expect(panel.locator('.markdown strong')).toHaveText('login');
  await expect(panel.locator('.pr-row', { hasText: 'Test (ubuntu)' })).toBeVisible();
  await expect(panel.locator('.pr-row', { hasText: 'ana' })).toContainText('approved');
  await expect(panel.locator('.pr-row', { hasText: 'sam' })).toContainText('awaiting review');
  await expect(panel.locator('.pr-comment', { hasText: 'Will look tomorrow' })).toBeVisible();
  // The PR's tip is selected in the graph.
  await expect(row(page, 'Add login page')).toHaveClass(/selected/);
  // Everything needed fits at the smallest window.
  await expect(page.getByRole('button', { name: 'Merge options' })).toBeInViewport();
  await expect(panel.locator('.pr-compose textarea')).toBeInViewport();

  const called = (args: string[]) => expect.poll(() => gl.ghCalls().find((c) => c.args.join(' ') === args.join(' ')) ?? null);

  await panel.locator('.pr-compose textarea').fill('Ship it');
  await panel.getByRole('button', { name: 'Comment' }).click();
  await called(['pr', 'comment', '7', '--body-file', '-']).toMatchObject({ stdin: 'Ship it' });
  await expect(panel.locator('.pr-compose textarea')).toHaveValue('');

  await panel.getByRole('button', { name: /^Review/ }).click();
  await page.locator('.menu-item', { hasText: 'Approve' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Approve' }).click();
  await called(['pr', 'review', '7', '--approve']).toBeTruthy();

  await page.getByRole('button', { name: 'Merge options' }).click();
  await page.locator('.menu-item', { hasText: 'Squash and merge' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Squash and merge' }).click();
  await called(['pr', 'merge', '7', '--squash', '--delete-branch']).toBeTruthy();

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test("a failed pull request load doesn't stick: refreshing tries again", async ({ gl }) => {
  const { page } = gl;
  gl.write('a.txt', '1\n');
  gl.git('add', '.');
  gl.git('commit', '-qm', 'Initial');
  gl.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  const pr = {
    number: 8,
    title: 'Fix typo',
    headRefName: 'fix',
    headRefOid: gl.git('rev-parse', 'HEAD'),
    baseRefName: 'main',
    author: { login: 'mate' },
    url: 'https://github.com/example/repo/pull/8',
    isDraft: false,
    reviewDecision: '',
    statusCheckRollup: [],
    isCrossRepository: false,
  };
  gl.setGh({ user: 'me', prs: [pr], fail: { 'pr list': 'error connecting to api.github.com' } });
  await gl.open();
  await expect(page.locator('.side-note', { hasText: 'error connecting to api.github.com' })).toBeVisible();

  // The network comes back.
  gl.setGh({ user: 'me', prs: [pr] });
  await page.getByRole('button', { name: 'Refresh pull requests' }).click();
  await expect(page.locator('.pr-item', { hasText: 'Fix typo' })).toBeVisible();
  await expect(page.locator('.side-note', { hasText: 'error connecting' })).toHaveCount(0);
});
