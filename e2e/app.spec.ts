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
  await page.locator('.conflict-card .seg button', { hasText: /^Theirs$/ }).click();
  await page.getByRole('button', { name: 'Save & Mark Resolved' }).click();
  await expect(page.locator('.btn-commit')).toHaveText('Commit merge');
  await page.locator('.btn-commit').click();
  await expect.poll(() => gl.git('log', '-1', '--format=%p').split(' ').length).toBe(2);
  expect(gl.read('config.txt')).toBe('speed = 120\n');
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

  await page.locator('.trail-branch').click();
  const item = page.locator('.context-menu .menu-item', { hasText: 'origin/feature/remote-only' });
  await expect(item.locator('.menu-icon svg')).toBeVisible();
  await item.click();
  await expect(page.locator('.trail-branch', { hasText: 'feature/remote-only' })).toBeVisible();
  expect(gl.git('rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/remote-only');
});
