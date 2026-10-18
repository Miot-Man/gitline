import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, ops, tmpDir } from './helpers';

// Every gh call goes to the fake gh, which answers from a fixture and logs what it was asked.
const dir = tmpDir();
const fixtureFile = path.join(dir, 'gh.json');
const logFile = path.join(dir, 'gh-log.jsonl');
process.env.GITLINE_GH = path.join(import.meta.dirname, 'fake-gh.cjs');
process.env.GITLINE_GH_FIXTURE = fixtureFile;
process.env.GITLINE_GH_LOG = logFile;

const setGh = (fixture: object) => fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
const calls = (): { args: string[]; stdin: string | null }[] =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const last = () => calls().filter((c) => !(c.args[0] === 'api' && c.args[1] === 'user')).pop();

const PR = {
  number: 7,
  title: 'Add login',
  body: '## Why\nPeople asked.',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'mate' },
  headRefName: 'feature/login',
  headRefOid: 'abc123',
  baseRefName: 'main',
  url: 'https://github.com/example/repo/pull/7',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: [{ __typename: 'User', login: 'sam' }, { __typename: 'Team', name: 'core' }],
  reviews: [
    { author: { login: 'ana' }, state: 'COMMENTED', body: 'Looks close', submittedAt: '2026-10-01T11:00:00Z' },
    { author: { login: 'ana' }, state: 'APPROVED', body: '', submittedAt: '2026-10-01T12:00:00Z' },
  ],
  comments: [{ author: { login: 'sam' }, body: 'Will look tomorrow', createdAt: '2026-10-01T10:30:00Z', url: 'https://github.com/example/repo/pull/7#c1' }],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Test (ubuntu)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
    { __typename: 'CheckRun', name: 'Test (macos)', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://ci/2' },
    { __typename: 'StatusContext', context: 'deploy/preview', state: 'FAILURE', targetUrl: 'https://deploy/3' },
  ],
  commits: [{}, {}],
  additions: 40,
  deletions: 3,
  changedFiles: 4,
  isCrossRepository: false,
};

beforeEach(() => {
  fs.rmSync(logFile, { force: true });
  setGh({ user: 'me', pr: PR });
});
afterAll(cleanup);

describe('pull request details', () => {
  it('maps gh pr view into the panel model', async () => {
    const d = await ops.ghPrDetails(dir, 7);
    expect(d).toMatchObject({
      number: 7,
      title: 'Add login',
      state: 'open',
      author: 'mate',
      head: 'feature/login',
      sha: 'abc123',
      base: 'main',
      mergeable: true,
      mergeState: 'blocked',
      requested: ['sam', 'core'],
      commits: 2,
      additions: 40,
      deletions: 3,
      files: 4,
      fork: false,
      viewer: 'me',
      checksState: 'failure',
      created: Date.parse('2026-10-01T10:00:00Z') / 1000,
    });
    expect(d.checks).toEqual([
      { name: 'Test (ubuntu)', workflow: 'CI', state: 'success', url: 'https://ci/1' },
      { name: 'Test (macos)', workflow: 'CI', state: 'pending', url: 'https://ci/2' },
      { name: 'deploy/preview', workflow: '', state: 'failure', url: 'https://deploy/3' },
    ]);
    expect(d.reviews.map((r: { author: string; state: string }) => `${r.author}:${r.state}`)).toEqual(['ana:COMMENTED', 'ana:APPROVED']);
    expect(d.comments[0]).toMatchObject({ author: 'sam', body: 'Will look tomorrow' });
    expect(calls().some((c) => c.args.join(' ').startsWith('pr view 7 --json'))).toBe(true);
  });

  it('reports drafts, merged PRs and unknown mergeability', async () => {
    setGh({ user: 'me', pr: { ...PR, isDraft: true, mergeable: 'UNKNOWN' } });
    expect(await ops.ghPrDetails(dir, 7)).toMatchObject({ state: 'draft', mergeable: null });
    setGh({ user: 'me', pr: { ...PR, state: 'MERGED', mergeable: 'CONFLICTING' } });
    expect(await ops.ghPrDetails(dir, 7)).toMatchObject({ state: 'merged', mergeable: false });
  });
});

describe('pull request actions', () => {
  it('merges with the chosen method', async () => {
    await ops.ghMergePr(dir, 7, 'squash', true);
    expect(last()?.args).toEqual(['pr', 'merge', '7', '--squash', '--delete-branch']);
    await ops.ghMergePr(dir, 7, 'rebase', false);
    expect(last()?.args).toEqual(['pr', 'merge', '7', '--rebase']);
  });

  it('closes, reopens, and moves between draft and ready', async () => {
    await ops.ghClosePr(dir, 7);
    expect(last()?.args).toEqual(['pr', 'close', '7']);
    await ops.ghReopenPr(dir, 7);
    expect(last()?.args).toEqual(['pr', 'reopen', '7']);
    await ops.ghReadyPr(dir, 7, false);
    expect(last()?.args).toEqual(['pr', 'ready', '7']);
    await ops.ghReadyPr(dir, 7, true);
    expect(last()?.args).toEqual(['pr', 'ready', '7', '--undo']);
  });

  it('sends comment, review and description text on stdin', async () => {
    const body = 'Multi-line\n\n- with `code` and "quotes"';
    await ops.ghCommentPr(dir, 7, body);
    expect(last()).toEqual({ args: ['pr', 'comment', '7', '--body-file', '-'], stdin: body });
    await ops.ghReviewPr(dir, 7, 'request-changes', 'Please add tests');
    expect(last()).toEqual({ args: ['pr', 'review', '7', '--request-changes', '--body-file', '-'], stdin: 'Please add tests' });
    await ops.ghReviewPr(dir, 7, 'approve', '');
    expect(last()).toEqual({ args: ['pr', 'review', '7', '--approve'], stdin: null });
    await ops.ghEditPr(dir, 7, { title: 'Add login page' });
    expect(last()).toEqual({ args: ['pr', 'edit', '7', '--title', 'Add login page'], stdin: null });
    await ops.ghEditPr(dir, 7, { body: 'New description' });
    expect(last()).toEqual({ args: ['pr', 'edit', '7', '--body-file', '-'], stdin: 'New description' });
  });

  it("passes gh's error message on", async () => {
    setGh({ user: 'me', pr: PR, fail: { 'pr merge': 'Pull request example/repo#7 is not mergeable: the base branch policy prohibits the merge.' } });
    await expect(ops.ghMergePr(dir, 7, 'merge', false)).rejects.toThrow(/base branch policy prohibits the merge/);
    setGh({ user: 'me', pr: PR, fail: { 'pr comment': 'GraphQL: Could not add comment' } });
    await expect(ops.ghCommentPr(dir, 7, 'hi')).rejects.toThrow('GraphQL: Could not add comment');
  });
});
