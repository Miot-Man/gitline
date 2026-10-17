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

export interface FileChange {
  path: string;
  oldPath?: string;
  status: string; // M A D R C U ? T
}

export interface Status {
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
}

export type RepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

export interface RepoInfo {
  head: string | null;
  branch: string | null;
  state: RepoState;
  mergeMsg: string | null;
  remotes: string[];
  fetchedAt: number | null; // ms since epoch of the last fetch/pull, if any
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
  base: string;
  author: string;
  url: string;
  draft: boolean;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  fork: boolean;
  checks: 'success' | 'failure' | 'pending' | null;
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
