// Undo/redo history. Each entry stores the git ops that reverse and replay an action,
// plus the HEAD state on either side so we can refuse to act on a repo that moved since.

export interface HeadState {
  head: string | null;
  branch: string | null;
}

export interface Step {
  op: string;
  args: unknown[];
}

export interface UndoEntry {
  label: string;
  undo: Step[];
  redo: Step[];
  before: HeadState;
  after: HeadState;
  // Commit message to put back in the commit box when a commit is undone.
  message?: string;
}

export type ResetMode = 'soft' | 'mixed' | 'keep';

const step = (op: string, ...args: unknown[]): Step => ({ op, args });

export const sameHead = (a: HeadState, b: HeadState) => a.head === b.head && a.branch === b.branch;

const checkoutStep = (s: HeadState) => step('checkout', s.branch ?? s.head);

// Actions that move the current branch: commit, amend, merge, rebase, pull, cherry-pick, revert, reset.
// `soft` keeps the undone changes staged; `keep` refuses to clobber local edits.
export function headMove(label: string, before: HeadState, after: HeadState, mode: ResetMode): UndoEntry | null {
  if (!before.head || !after.head || before.head === after.head || before.branch !== after.branch) return null;
  return {
    label,
    before,
    after,
    undo: [step('reset', before.head, mode)],
    redo: [step('reset', after.head, mode)],
  };
}

export function checkoutMove(label: string, before: HeadState, after: HeadState): UndoEntry | null {
  if (sameHead(before, after) || (!before.branch && !before.head)) return null;
  return { label, before, after, undo: [checkoutStep(before)], redo: [checkoutStep(after)] };
}

export function branchCreated(name: string, sha: string, before: HeadState, after: HeadState): UndoEntry {
  const full = `refs/heads/${name}`;
  const checkedOut = after.branch === name;
  return {
    label: `Create branch ${name}`,
    before,
    after,
    undo: [...(checkedOut ? [checkoutStep(before)] : []), step('deleteRef', full, sha)],
    redo: [step('createRef', full, sha), ...(checkedOut ? [checkoutStep(after)] : [])],
  };
}

export function refDeleted(label: string, full: string, sha: string, state: HeadState): UndoEntry {
  return { label, before: state, after: state, undo: [step('createRef', full, sha)], redo: [step('deleteRef', full, sha)] };
}

export function refCreated(label: string, full: string, sha: string, state: HeadState): UndoEntry {
  return { label, before: state, after: state, undo: [step('deleteRef', full, sha)], redo: [step('createRef', full, sha)] };
}

export function branchRenamed(from: string, to: string, before: HeadState, after: HeadState): UndoEntry {
  return {
    label: `Rename ${from} to ${to}`,
    before,
    after,
    undo: [step('renameBranch', to, from)],
    redo: [step('renameBranch', from, to)],
  };
}
