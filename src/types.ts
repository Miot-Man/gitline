export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
}

export type RefType = 'local' | 'remote' | 'tag';

export interface Ref {
  full: string;
  name: string;
  type: RefType;
  remote?: string;
  sha: string;
  upstream?: string;
  track?: string;
  isHead: boolean;
}

export interface Stash {
  ref: string;
  sha: string;
  message: string;
  index: number;
}

export type ConflictKind = 'both-modified' | 'both-added' | 'deleted-by-us' | 'deleted-by-them' | 'added-by-us' | 'added-by-them' | 'both-deleted';

export interface FileChange {
  path: string;
  oldPath?: string;
  status: string; // M A D R C U ? T
  conflict?: ConflictKind; // set on conflicted files (status 'U')
}

export interface Status {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
}

export type RepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

export interface OpCommit {
  sha: string;
  subject: string;
  name: string | null; // a branch or tag pointing at it
}

export interface RepoInfo {
  head: string | null;
  branch: string | null;
  state: RepoState;
  mergeMsg: string | null;
  opCommit: OpCommit | null; // the commit being merged, replayed, picked or reverted (git's "theirs")
  onto: OpCommit | null; // rebase: the commit being rebased onto (git's "ours")
  remotes: string[];
  fetchedAt: number | null; // ms since epoch of the last fetch/pull, if any
  bisecting: boolean;
}

export interface BisectState {
  done: boolean;
  firstBad?: string | null;
  left?: number | null;
  steps?: number | null;
  message?: string;
}

// What the active repo reports to the app shell for the rail badges and status bar.
export interface RepoStats {
  branch: string | null;
  ahead: number;
  behind: number;
  changes: number;
  prs: number;
  fetchedAt: number | null;
  undoLabel: string | null;
  busy: string | null;
  view: 'history' | 'changes';
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: FileChange[];
}

export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'latin1';

export interface ConflictFile {
  text: string | null; // null when the file isn't in the working tree
  encoding: FileEncoding;
}

export interface OpResult {
  conflict: boolean;
  output: string;
}

export type DiffTarget =
  | { kind: 'wip'; file: FileChange; staged: boolean }
  | { kind: 'commit'; sha: string; parent?: string; file: FileChange };

export const WIP = '__WIP__';

export interface FileLogEntry extends Commit {
  file: FileChange; // the file as it was in this commit (path changes across renames)
}

export interface BlameCommit {
  author: string;
  email: string;
  time: number;
  summary: string;
}

export interface Blame {
  commits: Record<string, BlameCommit>;
  lines: { sha: string; text: string }[];
}

export interface GraphFilter {
  solo: string[];
  hidden: string[];
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  message: string;
}

export interface PullRequest {
  number: number;
  title: string;
  head: string;
  sha: string; // the PR branch's tip on GitHub
  base: string;
  author: string;
  url: string;
  draft: boolean;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  fork: boolean;
  checks: 'success' | 'failure' | 'pending' | null;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrCheck {
  name: string;
  workflow: string;
  state: 'success' | 'failure' | 'pending';
  url: string;
}

export interface PrReview {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  time: number;
}

export interface PrComment {
  author: string;
  body: string;
  time: number;
  url: string;
}

// One pull request in full, for the PR panel.
export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  state: PrState;
  author: string;
  head: string;
  sha: string;
  base: string;
  url: string;
  created: number;
  updated: number;
  mergeable: boolean | null; // null while GitHub is still working it out
  mergeState: string; // GitHub's mergeStateStatus, lowercased: clean, blocked, behind, dirty, unstable, draft…
  review: PullRequest['review'];
  requested: string[]; // reviewers asked who haven't reviewed yet
  reviews: PrReview[];
  comments: PrComment[];
  checks: PrCheck[];
  checksState: PullRequest['checks'];
  commits: number;
  additions: number;
  deletions: number;
  files: number;
  fork: boolean;
  viewer: string | null; // the signed-in GitHub user
}

export interface CiStatus {
  state: 'success' | 'failure' | 'pending';
  url: string;
  name: string;
}

export interface GhStatus {
  ok: boolean;
  reason?: string;
}

export interface Author {
  name: string;
  email: string;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  current: boolean;
}

export interface Submodule {
  path: string;
  sha: string;
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe: string | null;
}

export interface LfsInfo {
  used: boolean;
  installed: boolean;
  files: number;
}
