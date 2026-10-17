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
