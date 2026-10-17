import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Commit, CommitDetails, DiffTarget, FileChange, GraphFilter, OpResult, RebaseCommit, Ref, RepoInfo, Stash, Status } from '../types';
import { WIP } from '../types';
import { api, basename, cleanError, git, joinPath } from '../api';
import { computeGraph } from '../lib/graph';
import { parseTrack } from '../lib/format';
import { Splitter, useUI, type MenuItem } from './ui';
import { Toolbar, PULL_LABELS, type PullMode } from './Toolbar';
import { Sidebar } from './Sidebar';
import { CommitGraph, type WipCounts } from './CommitGraph';
import { CommitPanel, ComparePanel, StagingPanel } from './RightPanel';
import { DiffView } from './DiffView';
import { FileHistory, type FileViewMode } from './FileHistory';
import { InteractiveRebase, type RebaseStep } from './InteractiveRebase';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import {
  branchCreated,
  branchRenamed,
  checkoutMove,
  headMove,
  refCreated,
  refDeleted,
  sameHead,
  type HeadState,
  type UndoEntry,
} from '../lib/undo';

interface Props {
  path: string;
  active: boolean;
  command: { name: string; n: number } | null;
  onRepoMenu: (e: React.MouseEvent) => void;
  appCommands: PaletteCommand[];
}

const EMPTY_STATUS: Status = { staged: [], unstaged: [], conflicted: [] };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isOpResult = (r: unknown): r is OpResult => !!r && typeof r === 'object' && 'conflict' in r;
const HISTORY_LIMIT = 50;
const NO_FILTER: GraphFilter = { solo: [], hidden: [] };
const shortRef = (full: string) => full.replace(/^refs\/(heads|remotes|tags)\//, '');

function loadFilter(path: string): GraphFilter {
  try {
    const f = JSON.parse(localStorage.getItem(`graphFilter:${path}`) ?? '');
    if (Array.isArray(f.solo) && Array.isArray(f.hidden)) return f;
  } catch {}
  return NO_FILTER;
}

export function RepoView({ path, active, command, onRepoMenu, appCommands }: Props) {
  const ui = useUI();
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<{ sha: string; n: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [amend, setAmend] = useState(false);
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('sideW')) || 250);
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem('rightW')) || 380);
  const [pullMode, setPullMode] = useState<PullMode>(() => (localStorage.getItem('pullMode') as PullMode) || 'ff');
  const [history, setHistory] = useState<{ undo: UndoEntry[]; redo: UndoEntry[] }>({ undo: [], redo: [] });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fileView, setFileView] = useState<{ path: string; mode: FileViewMode; rev?: string } | null>(null);
  const [compareSha, setCompareSha] = useState<string | null>(null);
  const [graphFilter, setGraphFilter] = useState<GraphFilter>(() => loadFilter(path));
  const [rebaseEditor, setRebaseEditor] = useState<{ base: string; commits: RebaseCommit[] } | null>(null);
  const filterRef = useRef(graphFilter);
  filterRef.current = graphFilter;
  const seq = useRef(0);
  const didInitialSelect = useRef(false);

  // ---------- loading ----------
  const refreshAll = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [i, c, r, s, st] = await Promise.all([
        git<RepoInfo>('info', path),
        git<Commit[]>('log', path, 5000, filterRef.current),
        git<Ref[]>('refs', path),
        git<Stash[]>('stashes', path),
        git<Status>('status', path),
      ]);
      if (n !== seq.current) return;
      setInfo(i);
      setCommits(c);
      setRefs(r);
      setStashes(s);
      setStatus(st);
      setLoadError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      if (n === seq.current) setLoadError(cleanError(e));
    }
  }, [path]);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await git<Status>('status', path);
      setStatus(st);
      setVersion((v) => v + 1);
    } catch {}
  }, [path]);

  useEffect(() => {
    api.watch(path);
    refreshAll();
    const off = api.onRepoChanged((d) => {
      if (d.path !== path) return;
      d.gitChanged ? refreshAll() : refreshStatus();
    });
    return () => {
      off();
      api.unwatch(path);
    };
  }, [path, refreshAll, refreshStatus]);

  useEffect(() => {
    if (!active) return;
    return api.onFocus(() => refreshAll());
  }, [active, refreshAll]);

  // Background fetch every 5 minutes.
  const hasRemotes = !!info?.remotes.length;
  useEffect(() => {
    if (!hasRemotes) return;
    const t = setInterval(() => {
      git('fetch', path)
        .then(refreshAll)
        .catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [hasRemotes, path, refreshAll]);

  // Reload the graph when branches are hidden / solo'd.
  const firstFilter = useRef(true);
  useEffect(() => {
    localStorage.setItem(`graphFilter:${path}`, JSON.stringify(graphFilter));
    if (firstFilter.current) firstFilter.current = false;
    else refreshAll();
  }, [graphFilter, path, refreshAll]);

  useEffect(() => localStorage.setItem('sideW', String(sideW)), [sideW]);
  useEffect(() => localStorage.setItem('rightW', String(rightW)), [rightW]);

  // ---------- derived ----------
  const totalChanges = status.staged.length + status.unstaged.length + status.conflicted.length;
  const showWip = totalChanges > 0 || !!info?.state;

  // The default branch keeps the leftmost lane of the graph.
  const trunk = useMemo(() => {
    for (const name of ['main', 'master', 'origin/main', 'origin/master']) {
      const r = refs.find((x) => x.name === name && x.type !== 'tag');
      if (r) return r.sha;
    }
    return null;
  }, [refs]);

  const graph = useMemo(() => {
    const list: Commit[] = showWip
      ? [{ sha: WIP, parents: info?.head ? [info.head] : [], author: '', email: '', time: 0, subject: '' }, ...commits]
      : commits;
    const { rows, maxLanes } = computeGraph(list, trunk && showWip && info?.head === trunk ? WIP : trunk);
    return { items: list.map((commit, i) => ({ commit, graph: rows[i] })), maxLanes };
  }, [commits, showWip, info?.head, trunk]);

  const refsBySha = useMemo(() => {
    const m = new Map<string, Ref[]>();
    for (const r of refs) {
      const arr = m.get(r.sha) ?? [];
      arr.push(r);
      m.set(r.sha, arr);
    }
    return m;
  }, [refs]);

  const wipCounts: WipCounts = useMemo(() => {
    const all = new Map<string, string>();
    [...status.staged, ...status.unstaged].forEach((f) => {
      if (!all.has(f.path) || all.get(f.path) === 'M') all.set(f.path, f.status);
    });
    let modified = 0;
    let added = 0;
    let deleted = 0;
    all.forEach((s) => (s === 'A' || s === '?' ? added++ : s === 'D' ? deleted++ : modified++));
    return { modified, added, deleted, conflicted: status.conflicted.length };
  }, [status]);

  const currentRef = refs.find((r) => r.type === 'local' && r.isHead);
  const track = parseTrack(currentRef?.track);
  const locals = refs.filter((r) => r.type === 'local');

  // ---------- selection housekeeping ----------
  useEffect(() => {
    if (!info) return;
    if (!didInitialSelect.current) {
      didInitialSelect.current = true;
      setSelected(showWip ? WIP : info.head);
      if (info.head && !showWip) setScrollTarget({ sha: info.head, n: Date.now() });
      return;
    }
    if (selected === WIP && !showWip) setSelected(info.head);
    if (!selected && showWip) setSelected(WIP);
  }, [info, showWip, selected]);

  // Keep an open working-copy diff pointed at the list the file now lives in.
  useEffect(() => {
    if (!diff || diff.kind !== 'wip') return;
    const inList = (list: FileChange[]) => list.find((f) => f.path === diff.file.path);
    const same = diff.staged ? inList(status.staged) : inList(status.unstaged) ?? inList(status.conflicted);
    if (same) {
      if (same.status !== diff.file.status) setDiff({ ...diff, file: same });
      return;
    }
    const other = diff.staged ? inList(status.unstaged) ?? inList(status.conflicted) : inList(status.staged);
    setDiff(other ? { kind: 'wip', file: other, staged: !diff.staged } : null);
  }, [status, diff]);

  // Prefill the commit message while a merge / cherry-pick / revert is in progress.
  const prevState = useRef<string | null>(null);
  useEffect(() => {
    const st = info?.state ?? null;
    if (st && st !== prevState.current && info?.mergeMsg && !summary) {
      const [first, ...rest] = info.mergeMsg.split('\n');
      setSummary(first);
      setDescription(rest.join('\n').trim());
    }
    prevState.current = st;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.state, info?.mergeMsg]);

  // ---------- menu commands ----------
  useEffect(() => {
    if (!command || !active) return;
    if (command.name === 'refresh') refreshAll();
    if (command.name === 'find') {
      setDiff(null);
      setFileView(null);
      setFindOpen(true);
    }
    if (command.name === 'undo' || command.name === 'redo') applyHistory(command.name);
    if (command.name === 'palette') setPaletteOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // ---------- actions ----------
  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(label);
      try {
        const r = await fn();
        if (isOpResult(r) && r.conflict) {
          ui.toast('Conflicts detected. Resolve them in the right panel, then commit or continue.', 'error');
          setSelected(WIP);
        } else if (success) ui.toast(success, 'success');
        return r;
      } catch (e) {
        ui.toast(cleanError(e), 'error');
        return undefined;
      } finally {
        setBusy(null);
        await refreshAll();
      }
    },
    [ui, refreshAll]
  );

  // ---------- undo / redo ----------
  const headState = () => git<HeadState>('headState', path).catch(() => null);

  const record = (entry: UndoEntry | null) => {
    if (entry) setHistory((h) => ({ undo: [...h.undo, entry].slice(-HISTORY_LIMIT), redo: [] }));
  };

  // Like `run`, but snapshots HEAD around the action and records how to undo it.
  const tracked = async <T,>(
    label: string,
    fn: () => Promise<T>,
    success: string | undefined,
    make: (before: HeadState, after: HeadState) => UndoEntry | null
  ) => {
    const before = await headState();
    let ok = false;
    const r = await run(
      label,
      async () => {
        const v = await fn();
        ok = !(isOpResult(v) && v.conflict);
        return v;
      },
      success
    );
    if (ok && before) {
      const after = await headState();
      if (after) record(make(before, after));
    }
    return r;
  };

  const applyHistory = async (dir: 'undo' | 'redo') => {
    if (busy) return;
    const entry = history[dir][history[dir].length - 1];
    if (!entry) return ui.toast(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo', 'info');
    const cur = await headState();
    if (!cur || !sameHead(cur, dir === 'undo' ? entry.after : entry.before)) {
      setHistory({ undo: [], redo: [] });
      return ui.toast(`Can't ${dir} "${entry.label}" because the repository has changed since. Undo history cleared.`, 'error');
    }
    let ok = false;
    await run(
      dir === 'undo' ? 'Undoing…' : 'Redoing…',
      async () => {
        for (const s of entry[dir]) await git(s.op, path, ...s.args);
        ok = true;
      },
      `${dir === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}`
    );
    if (!ok) return;
    setHistory((h) =>
      dir === 'undo'
        ? { undo: h.undo.slice(0, -1), redo: [...h.redo, entry] }
        : { undo: [...h.undo, entry], redo: h.redo.slice(0, -1) }
    );
    if (dir === 'undo' && entry.message && !summary.trim()) {
      const [first, ...rest] = entry.message.split('\n');
      setSummary(first);
      setDescription(rest.join('\n').trim());
    }
  };

  const selectSha = (sha: string) => {
    setSelected(sha);
    setCompareSha(null);
    setFileView(null);
    setDiff(null);
    setScrollTarget({ sha, n: Date.now() });
  };

  const checkoutRef = (r: Ref) => {
    const undo = (b: HeadState, a: HeadState) => checkoutMove(`Checkout ${r.name}`, b, a);
    if (r.type === 'local') {
      if (r.isHead) return;
      tracked(`Checking out ${r.name}…`, () => git('checkout', path, r.name), `Checked out ${r.name}`, undo);
    } else if (r.type === 'remote') {
      tracked(`Checking out ${r.name}…`, () => git('checkoutRemote', path, r.name), `Checked out ${r.name.split('/').slice(1).join('/')}`, undo);
    } else {
      tracked(`Checking out ${r.name}…`, () => git('checkout', path, r.name), `Checked out tag ${r.name} (detached HEAD)`, undo);
    }
  };

  const checkoutCommit = (sha: string) => {
    const short = sha.slice(0, 7);
    tracked('Checking out…', () => git('checkout', path, sha), `Checked out ${short}`, (b, a) => checkoutMove(`Checkout ${short}`, b, a));
  };

  const createBranch = async (start?: string) => {
    const name = await ui.prompt({ title: 'Create branch', label: 'Branch name', placeholder: 'feature/my-branch', confirmText: 'Create Branch' });
    if (!name) return;
    const branch = name.replace(/\s+/g, '-');
    tracked('Creating branch…', () => git('createBranch', path, branch, start, true), `Created and checked out ${branch}`, (b, a) =>
      a.head ? branchCreated(branch, a.head, b, a) : null
    );
  };

  const deleteBranch = async (r: Ref) => {
    if (!(await ui.confirm({ title: 'Delete branch', message: <>Delete local branch <b>{r.name}</b>?</>, confirmText: 'Delete', danger: true }))) return;
    const deleted = async () => {
      ui.toast(`Deleted ${r.name}`, 'success');
      const state = await headState();
      if (state) record(refDeleted(`Delete branch ${r.name}`, r.full, r.sha, state));
    };
    setBusy('Deleting branch…');
    try {
      await git('deleteBranch', path, r.name, false);
      await deleted();
    } catch (e) {
      const msg = cleanError(e);
      if (/not fully merged/.test(msg)) {
        if (
          await ui.confirm({
            title: 'Branch not fully merged',
            message: <><b>{r.name}</b> has commits that are not merged anywhere. Delete it anyway? Those commits may be lost.</>,
            confirmText: 'Force Delete',
            danger: true,
          })
        ) {
          try {
            await git('deleteBranch', path, r.name, true);
            await deleted();
          } catch (e2) {
            ui.toast(cleanError(e2), 'error');
          }
        }
      } else ui.toast(msg, 'error');
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  const renameBranch = async (r: Ref) => {
    const name = await ui.prompt({ title: 'Rename branch', label: 'New name', initial: r.name, confirmText: 'Rename' });
    if (name && name !== r.name)
      tracked('Renaming…', () => git('renameBranch', path, r.name, name), `Renamed to ${name}`, (b, a) => branchRenamed(r.name, name, b, a));
  };

  const push = async (branch?: string) => {
    setBusy('Pushing…');
    try {
      const r = await git<{ setUpstream: boolean; remote?: string }>('push', path, branch, false);
      ui.toast(r.setUpstream ? `Pushed and set upstream to ${r.remote}` : 'Pushed', 'success');
    } catch (e) {
      const msg = cleanError(e);
      if (/rejected|non-fast-forward|fetch first/i.test(msg)) {
        const ok = await ui.confirm({
          title: 'Push rejected',
          message: 'The remote branch has commits that are not in your local branch. Pull first, or force push to overwrite the remote (uses --force-with-lease).',
          confirmText: 'Force Push',
          danger: true,
        });
        if (ok) {
          try {
            await git('push', path, branch, true);
            ui.toast('Force pushed', 'success');
          } catch (e2) {
            ui.toast(cleanError(e2), 'error');
          }
        }
      } else ui.toast(msg, 'error');
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  const pull = (mode: PullMode = pullMode) => tracked('Pulling…', () => git('pull', path, mode), 'Pulled', (b, a) => headMove('Pull', b, a, 'keep'));

  const mergeRef = (name: string) => {
    const cur = info?.branch ?? 'HEAD';
    tracked('Merging…', () => git('merge', path, name), `Merged ${name} into ${cur}`, (b, a) => headMove(`Merge ${name} into ${cur}`, b, a, 'keep'));
  };
  const rebaseOnto = (name: string) => {
    const cur = info?.branch ?? 'HEAD';
    tracked('Rebasing…', () => git('rebase', path, name), `Rebased ${cur} onto ${name}`, (b, a) => headMove(`Rebase ${cur} onto ${name}`, b, a, 'keep'));
  };
  const fetchAll = () => run('Fetching…', () => git('fetch', path), 'Fetched all remotes');

  const stash = async () => {
    if (!totalChanges) return ui.toast('No local changes to stash', 'info');
    await run('Stashing…', () => git('stash', path, summary.trim() || undefined), 'Stashed changes');
    setSummary('');
    setDescription('');
  };
  const pop = () => run('Popping stash…', () => git('stashPop', path), 'Popped stash');

  const commit = async () => {
    const msg = summary.trim();
    const full = [msg, description.trim()].filter(Boolean).join('\n\n');
    const ok = await tracked(
      amend ? 'Amending…' : 'Committing…',
      () => git('commit', path, msg, description, amend).then(() => true),
      undefined,
      (b, a) => {
        const e = headMove(`${amend ? 'Amend' : 'Commit'} "${msg}"`, b, a, 'soft');
        return e && { ...e, message: full };
      }
    );
    if (ok) {
      setSummary('');
      setDescription('');
      setAmend(false);
      setDiff(null);
    }
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !summary.trim()) {
      try {
        const msg = await git<string>('lastCommitMessage', path);
        const [first, ...rest] = msg.split('\n');
        setSummary(first);
        setDescription(rest.join('\n').trim());
      } catch {}
    }
  };

  const discardAll = async () => {
    if (
      await ui.confirm({
        title: 'Discard all changes',
        message: 'This will permanently discard all staged, unstaged and untracked changes. This cannot be undone.',
        confirmText: 'Discard All',
        danger: true,
      })
    ) {
      setDiff(null);
      run('Discarding…', () => git('discardAll', path), 'Discarded all changes');
    }
  };

  const discardFiles = async (files: FileChange[]) => {
    const label = files.length === 1 ? files[0].path : `${files.length} files`;
    if (await ui.confirm({ title: 'Discard changes', message: <>Discard changes to <b>{label}</b>? This cannot be undone.</>, confirmText: 'Discard', danger: true }))
      run('Discarding…', () => git('discard', path, files));
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    ui.toast('Copied to clipboard', 'success');
  };

  // ---------- file history, compare, graph filter, interactive rebase ----------
  const openFileView = (file: string, mode: FileViewMode, rev?: string) => {
    setDiff(null);
    setFileView({ path: file, mode, rev });
  };

  const compareWithHead = (sha: string) => {
    if (!info?.head || sha === info.head) return;
    setSelected(info.head);
    setCompareSha(sha);
    setDiff(null);
    setFileView(null);
  };

  const toggleHidden = (r: Ref) =>
    setGraphFilter((f) => ({
      solo: f.solo.filter((x) => x !== r.full),
      hidden: f.hidden.includes(r.full) ? f.hidden.filter((x) => x !== r.full) : [...f.hidden, r.full],
    }));
  const toggleSolo = (r: Ref) =>
    setGraphFilter((f) => ({
      hidden: f.hidden.filter((x) => x !== r.full),
      solo: f.solo.includes(r.full) ? f.solo.filter((x) => x !== r.full) : [...f.solo, r.full],
    }));
  const filterActive = graphFilter.solo.length > 0 || graphFilter.hidden.length > 0;

  // Forget hidden / solo'd refs that no longer exist.
  useEffect(() => {
    if (!refs.length) return;
    const have = new Set(refs.map((r) => r.full));
    if ([...graphFilter.solo, ...graphFilter.hidden].every((x) => have.has(x))) return;
    setGraphFilter((f) => ({ solo: f.solo.filter((x) => have.has(x)), hidden: f.hidden.filter((x) => have.has(x)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs]);

  const startInteractiveRebase = async (base: string) => {
    try {
      const plan = await git<RebaseCommit[]>('rebasePlan', path, base);
      if (!plan.length) return ui.toast('There are no commits after this one to rebase.', 'info');
      setRebaseEditor({ base, commits: plan });
    } catch (e) {
      ui.toast(cleanError(e), 'error');
    }
  };

  const runInteractiveRebase = (steps: RebaseStep[]) => {
    if (!rebaseEditor) return;
    const { base } = rebaseEditor;
    const cur = info?.branch ?? 'HEAD';
    setRebaseEditor(null);
    tracked('Rebasing…', () => git('interactiveRebase', path, base, steps), `Rebased ${cur}`, (b, a) =>
      headMove(`Interactive rebase of ${cur}`, b, a, 'keep')
    );
  };

  // ---------- context menus ----------
  const rowMenu = (e: React.MouseEvent, c: Commit) => {
    if (c.sha === WIP) {
      ui.menu(e, [
        { label: 'Stash all changes', onClick: stash },
        { label: 'Discard all changes', onClick: discardAll, danger: true },
      ]);
      return;
    }
    const short = c.sha.slice(0, 7);
    const cur = info?.branch ?? 'HEAD';
    ui.menu(e, [
      { label: 'Create branch here', onClick: () => createBranch(c.sha) },
      { label: 'Checkout this commit', hint: 'detached', onClick: () => checkoutCommit(c.sha) },
      'sep',
      {
        label: `Cherry pick commit`,
        onClick: () =>
          tracked('Cherry-picking…', () => git('cherryPick', path, c.sha), `Cherry-picked ${short}`, (b, a) => headMove(`Cherry-pick ${short}`, b, a, 'keep')),
      },
      {
        label: `Revert commit`,
        onClick: () =>
          tracked('Reverting…', () => git('revert', path, c.sha, c.parents.length > 1), `Reverted ${short}`, (b, a) => headMove(`Revert ${short}`, b, a, 'keep')),
      },
      'sep',
      { label: `Reset ${cur} to this commit — Soft`, onClick: () => resetTo(c.sha, 'soft') },
      { label: `Reset ${cur} to this commit — Mixed`, onClick: () => resetTo(c.sha, 'mixed') },
      { label: `Reset ${cur} to this commit — Hard`, onClick: () => resetTo(c.sha, 'hard'), danger: true },
      'sep',
      { label: `Interactive rebase ${cur} from here…`, disabled: !info?.branch || c.sha === info?.head, onClick: () => startInteractiveRebase(c.sha) },
      { label: 'Compare with HEAD', disabled: !info?.head || c.sha === info?.head, onClick: () => compareWithHead(c.sha) },
      'sep',
      { label: 'Create tag here', onClick: () => createTag(c.sha) },
      { label: 'Create annotated tag here', onClick: () => createTag(c.sha, true) },
      'sep',
      { label: 'Copy commit sha', onClick: () => copy(c.sha) },
      { label: 'Copy commit message', onClick: () => copy(c.subject) },
    ]);
  };

  const resetTo = async (sha: string, mode: 'soft' | 'mixed' | 'hard') => {
    if (
      mode === 'hard' &&
      !(await ui.confirm({
        title: 'Hard reset',
        message: <>Reset <b>{info?.branch ?? 'HEAD'}</b> to <code>{sha.slice(0, 7)}</code> and discard all working directory changes?</>,
        confirmText: 'Reset Hard',
        danger: true,
      }))
    )
      return;
    // A hard reset is undone with --keep so redoing it can't wipe edits made in between.
    tracked('Resetting…', () => git('reset', path, sha, mode), `Reset (${mode}) to ${sha.slice(0, 7)}`, (b, a) =>
      headMove(`Reset ${mode} to ${sha.slice(0, 7)}`, b, a, mode === 'hard' ? 'keep' : mode)
    );
  };

  const createTag = async (sha: string, annotated = false) => {
    const name = await ui.prompt({ title: annotated ? 'Create annotated tag' : 'Create tag', label: 'Tag name', placeholder: 'v1.0.0', confirmText: 'Create Tag' });
    if (!name) return;
    let message: string | null = null;
    if (annotated) {
      message = await ui.prompt({ title: 'Tag message', label: 'Message', multiline: true, confirmText: 'Create Tag' });
      if (!message) return;
    }
    const ok = await run('Tagging…', () => git('createTag', path, name, sha, message).then(() => true), `Created tag ${name}`);
    if (!ok) return;
    const full = `refs/tags/${name}`;
    const [tagSha, state] = await Promise.all([git<string | null>('refSha', path, full), headState()]);
    if (tagSha && state) record(refCreated(`Create tag ${name}`, full, tagSha, state));
  };

  const refMenu = (e: React.MouseEvent, r: Ref) => {
    const cur = info?.branch;
    const items: MenuItem[] = [];
    if (r.type === 'local') {
      const isCur = r.isHead;
      if (!isCur) items.push({ label: `Checkout ${r.name}`, onClick: () => checkoutRef(r) });
      if (isCur) {
        items.push({ label: 'Pull', onClick: () => pull() });
        items.push({ label: 'Push', onClick: () => push() });
      } else {
        items.push({ label: `Push ${r.name}`, onClick: () => push(r.name) });
      }
      if (!isCur && cur) {
        items.push('sep');
        items.push({ label: `Merge ${r.name} into ${cur}`, onClick: () => mergeRef(r.name) });
        items.push({ label: `Rebase ${cur} onto ${r.name}`, onClick: () => rebaseOnto(r.name) });
      }
      items.push('sep');
      items.push({ label: 'Create branch here', onClick: () => createBranch(r.sha) });
      items.push({ label: `Rename ${r.name}`, onClick: () => renameBranch(r) });
      if (!isCur) items.push({ label: `Delete ${r.name}`, onClick: () => deleteBranch(r), danger: true });
      items.push('sep');
      items.push({ label: 'Copy branch name', onClick: () => copy(r.name) });
    } else if (r.type === 'remote') {
      const [remote, ...rest] = r.name.split('/');
      const branch = rest.join('/');
      items.push({ label: `Checkout ${branch}`, onClick: () => checkoutRef(r) });
      if (cur) {
        items.push('sep');
        items.push({ label: `Merge ${r.name} into ${cur}`, onClick: () => mergeRef(r.name) });
        items.push({ label: `Rebase ${cur} onto ${r.name}`, onClick: () => rebaseOnto(r.name) });
      }
      items.push('sep');
      items.push({ label: 'Create branch here', onClick: () => createBranch(r.sha) });
      items.push({
        label: `Delete ${r.name}`,
        danger: true,
        onClick: async () => {
          if (await ui.confirm({ title: 'Delete remote branch', message: <>Delete <b>{branch}</b> from <b>{remote}</b>?</>, confirmText: 'Delete', danger: true }))
            run('Deleting remote branch…', () => git('deleteRemoteBranch', path, remote, branch), `Deleted ${r.name}`);
        },
      });
      items.push('sep');
      items.push({ label: 'Copy branch name', onClick: () => copy(r.name) });
    } else {
      items.push({ label: `Checkout ${r.name}`, hint: 'detached', onClick: () => checkoutRef(r) });
      items.push({ label: 'Create branch here', onClick: () => createBranch(r.sha) });
      if (info?.remotes.length) {
        for (const remote of info.remotes)
          items.push({ label: `Push ${r.name} to ${remote}`, onClick: () => run('Pushing tag…', () => git('pushTag', path, remote, r.name), `Pushed ${r.name} to ${remote}`) });
      }
      items.push('sep');
      items.push({
        label: `Delete ${r.name}`,
        danger: true,
        onClick: async () => {
          if (!(await ui.confirm({ title: 'Delete tag', message: <>Delete local tag <b>{r.name}</b>?</>, confirmText: 'Delete', danger: true }))) return;
          const tagSha = await git<string | null>('refSha', path, r.full).catch(() => null);
          const ok = await run('Deleting tag…', () => git('deleteTag', path, r.name).then(() => true), `Deleted tag ${r.name}`);
          const state = ok && tagSha ? await headState() : null;
          if (tagSha && state) record(refDeleted(`Delete tag ${r.name}`, r.full, tagSha, state));
        },
      });
      items.push({ label: 'Copy tag name', onClick: () => copy(r.name) });
    }
    items.push('sep');
    if (!r.isHead) items.push({ label: graphFilter.hidden.includes(r.full) ? 'Show in graph' : 'Hide in graph', onClick: () => toggleHidden(r) });
    items.push({ label: graphFilter.solo.includes(r.full) ? 'Unsolo' : 'Solo in graph', onClick: () => toggleSolo(r) });
    if (filterActive) items.push({ label: 'Show all branches', onClick: () => setGraphFilter(NO_FILTER) });
    ui.menu(e, items);
  };

  const stashMenu = (e: React.MouseEvent, s: Stash) =>
    ui.menu(e, [
      { label: 'Apply stash', onClick: () => run('Applying stash…', () => git('stashApply', path, s.ref), 'Applied stash') },
      { label: 'Pop stash', onClick: () => run('Popping stash…', () => git('stashPop', path, s.ref), 'Popped stash') },
      'sep',
      {
        label: 'Delete stash',
        danger: true,
        onClick: async () => {
          if (await ui.confirm({ title: 'Delete stash', message: <>Delete <b>{s.message}</b>?</>, confirmText: 'Delete', danger: true }))
            run('Deleting stash…', () => git('stashDrop', path, s.ref), 'Deleted stash');
        },
      },
    ]);

  const remoteMenu = (e: React.MouseEvent, remote: string) =>
    ui.menu(e, [
      { label: 'Fetch all', onClick: fetchAll },
      { label: `Copy remote name`, onClick: () => copy(remote) },
      'sep',
      {
        label: `Remove ${remote}`,
        danger: true,
        onClick: async () => {
          if (await ui.confirm({ title: 'Remove remote', message: <>Remove remote <b>{remote}</b>?</>, confirmText: 'Remove', danger: true }))
            run('Removing remote…', () => git('removeRemote', path, remote), `Removed ${remote}`);
        },
      },
    ]);

  const addRemote = async () => {
    const name = await ui.prompt({ title: 'Add remote', label: 'Remote name', initial: info?.remotes.length ? '' : 'origin', confirmText: 'Next' });
    if (!name) return;
    const url = await ui.prompt({ title: `Add remote "${name}"`, label: 'URL', placeholder: 'https://github.com/user/repo.git', confirmText: 'Add Remote' });
    if (!url) return;
    await run('Adding remote…', () => git('addRemote', path, name, url), `Added remote ${name}`);
    fetchAll();
  };

  const fileMenu = (e: React.MouseEvent, f: FileChange, staged: boolean) => {
    const full = joinPath(path, f.path);
    const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.')) : null;
    const items: MenuItem[] = [];
    if (f.status === 'U') {
      items.push({ label: 'Take ours', onClick: () => run('Resolving…', () => git('resolve', path, f.path, 'ours')) });
      items.push({ label: 'Take theirs', onClick: () => run('Resolving…', () => git('resolve', path, f.path, 'theirs')) });
      items.push({ label: 'Mark resolved', onClick: () => run('Staging…', () => git('stage', path, [f.path])) });
    } else if (staged) items.push({ label: 'Unstage', onClick: () => run('Unstaging…', () => git('unstage', path, [f.path])) });
    else {
      items.push({ label: 'Stage', onClick: () => run('Staging…', () => git('stage', path, [f.path])) });
      items.push({ label: 'Discard changes', danger: true, onClick: () => discardFiles([f]) });
    }
    items.push('sep');
    if (f.status === '?') {
      items.push({ label: 'Ignore this file', onClick: () => run('Updating .gitignore…', () => git('ignore', path, `/${f.path}`)) });
      if (ext) items.push({ label: `Ignore all *${ext} files`, onClick: () => run('Updating .gitignore…', () => git('ignore', path, `*${ext}`)) });
      items.push('sep');
    }
    if (f.status !== '?' && f.status !== 'A') {
      items.push({ label: 'File history', onClick: () => openFileView(f.path, 'history') });
      items.push({ label: 'Blame', onClick: () => openFileView(f.path, 'blame') });
      items.push('sep');
    }
    items.push({ label: 'Open file', onClick: () => api.openPath(full) });
    items.push({ label: 'Show in folder', onClick: () => api.showItem(full) });
    items.push({ label: 'Copy file path', onClick: () => copy(f.path) });
    ui.menu(e, items);
  };

  const commitFileMenu = (e: React.MouseEvent, f: FileChange, sha: string) => {
    const full = joinPath(path, f.path);
    ui.menu(e, [
      { label: 'File history', onClick: () => openFileView(f.path, 'history') },
      { label: 'Blame at this commit', disabled: f.status === 'D', onClick: () => openFileView(f.path, 'blame', sha) },
      'sep',
      { label: 'Open file', onClick: () => api.openPath(full) },
      { label: 'Show in folder', onClick: () => api.showItem(full) },
      { label: 'Copy file path', onClick: () => copy(f.path) },
    ]);
  };

  const branchMenu = (e: React.MouseEvent) =>
    ui.menu(e, [
      ...locals.map((r) => ({ label: `${r.isHead ? '✓ ' : '   '}${r.name}`, onClick: () => checkoutRef(r) })),
      'sep' as const,
      { label: 'Create new branch…', onClick: () => createBranch() },
    ]);

  const pullMenu = (e: React.MouseEvent) =>
    ui.menu(e, [
      { label: 'Fetch All', onClick: fetchAll },
      'sep',
      ...(Object.keys(PULL_LABELS) as PullMode[]).map((m) => ({
        label: `${m === pullMode ? '✓ ' : '   '}${PULL_LABELS[m]}`,
        onClick: () => {
          setPullMode(m);
          localStorage.setItem('pullMode', m);
          pull(m);
        },
      })),
    ]);

  const closeFileView = useCallback(() => setFileView(null), []);

  // The older of the two compared commits (lower in the graph) is the "from" side.
  const compare = useMemo(() => {
    if (!compareSha || !selected || selected === WIP) return null;
    const a = commits.findIndex((c) => c.sha === selected);
    const b = commits.findIndex((c) => c.sha === compareSha);
    if (a < 0 || b < 0) return null;
    return a > b ? { base: commits[a], target: commits[b] } : { base: commits[b], target: commits[a] };
  }, [commits, selected, compareSha]);

  // ---------- command palette ----------
  const paletteCommands = (): PaletteCommand[] => {
    const cmds: PaletteCommand[] = [];
    const add = (group: string, label: string, run: () => void, hint?: string) => cmds.push({ id: `${group}:${label}`, group, label, run, hint });
    const lastUndo = history.undo[history.undo.length - 1];
    const lastRedo = history.redo[history.redo.length - 1];
    const cur = info?.branch;

    if (lastUndo) add('Edit', `Undo ${lastUndo.label}`, () => applyHistory('undo'), '⌘Z');
    if (lastRedo) add('Edit', `Redo ${lastRedo.label}`, () => applyHistory('redo'), '⇧⌘Z');
    add('Remote', 'Fetch all', fetchAll);
    for (const m of Object.keys(PULL_LABELS) as PullMode[]) add('Remote', PULL_LABELS[m], () => pull(m));
    add('Remote', 'Push', () => push());
    add('Remote', 'Add remote…', addRemote);
    add('Branch', 'Create branch…', () => createBranch());
    add('Changes', 'Stash changes', stash);
    if (stashes.length) add('Changes', 'Pop stash', pop);
    if (totalChanges) {
      add('Changes', 'Stage all changes', () => run('Staging…', () => git('stageAll', path)));
      add('Changes', 'Unstage all changes', () => run('Unstaging…', () => git('unstageAll', path)));
      add('Changes', 'Discard all changes', discardAll);
    }
    if (showWip) add('View', 'Show working changes', () => setSelected(WIP));
    if (info?.head) add('View', 'Go to HEAD', () => selectSha(info.head!));
    add('View', 'Find commit', () => {
      setDiff(null);
      setFileView(null);
      setFindOpen(true);
    }, '⌘F');
    add('View', 'Refresh', refreshAll, '⌘R');
    if (filterActive) add('View', 'Show all branches in graph', () => setGraphFilter(NO_FILTER));
    if (compare) add('View', 'Stop comparing', () => setCompareSha(null));
    add('Repo', 'Open in terminal', () => api.openTerminal(path));
    add('Repo', 'Reveal repository folder', () => api.openPath(path));

    for (const r of refs) {
      if (r.type === 'local' && r.isHead) continue;
      add(r.type === 'tag' ? 'Tag' : 'Branch', `Checkout ${r.name}`, () => checkoutRef(r));
    }
    if (cur) {
      for (const r of refs) {
        if (r.type === 'tag' || r.isHead) continue;
        add('Merge', `Merge ${r.name} into ${cur}`, () => mergeRef(r.name));
        add('Rebase', `Rebase ${cur} onto ${r.name}`, () => rebaseOnto(r.name));
      }
    }
    for (const s of stashes) {
      add('Stash', `Apply ${s.ref}: ${s.message}`, () => run('Applying stash…', () => git('stashApply', path, s.ref), 'Applied stash'));
      add('Stash', `Pop ${s.ref}: ${s.message}`, () => run('Popping stash…', () => git('stashPop', path, s.ref), 'Popped stash'));
    }
    return [...cmds, ...appCommands];
  };

  // ---------- render ----------
  if (loadError && !info) {
    return (
      <div className="repo-view" style={{ display: active ? 'flex' : 'none' }}>
        <div className="panel-empty big">
          Could not open {path}
          <pre>{loadError}</pre>
        </div>
      </div>
    );
  }

  const stagingVisible = selected === WIP || (!selected && showWip);

  return (
    <div className="repo-view" style={{ display: active ? 'flex' : 'none' }}>
      <Toolbar
        repoName={basename(path)}
        branch={info?.branch ?? null}
        busy={busy}
        ahead={track.ahead}
        behind={track.behind}
        canPop={stashes.length > 0}
        undoLabel={history.undo[history.undo.length - 1]?.label ?? null}
        redoLabel={history.redo[history.redo.length - 1]?.label ?? null}
        onUndo={() => applyHistory('undo')}
        onRedo={() => applyHistory('redo')}
        onRepoMenu={onRepoMenu}
        onBranchMenu={branchMenu}
        onPull={() => pull()}
        onPullMenu={pullMenu}
        onPush={() => push()}
        onBranch={() => createBranch()}
        onStash={stash}
        onPop={pop}
        onFetch={fetchAll}
        onTerminal={() => api.openTerminal(path)}
        onReveal={() => api.openPath(path)}
      />
      <div className="repo-main">
        <div className="side-wrap" style={{ width: sideW }}>
          <Sidebar
            refs={refs}
            stashes={stashes}
            remotes={info?.remotes ?? []}
            filter={graphFilter}
            onSelectSha={selectSha}
            onRefMenu={refMenu}
            onRefDoubleClick={checkoutRef}
            onStashMenu={stashMenu}
            onRemoteMenu={remoteMenu}
            onAddRemote={addRemote}
            onNewBranch={() => createBranch()}
          />
        </div>
        <Splitter onDrag={(dx) => setSideW((w) => clamp(w + dx, 170, 520))} />
        <div className="center">
          {fileView ? (
            <FileHistory
              repo={path}
              path={fileView.path}
              mode={fileView.mode}
              rev={fileView.rev}
              version={version}
              onMode={(mode) => setFileView({ ...fileView, mode })}
              onClose={closeFileView}
              onSelectSha={selectSha}
            />
          ) : diff ? (
            <DiffView
              repo={path}
              target={diff}
              version={version}
              onClose={() => setDiff(null)}
              onStageFile={() => run('Staging…', () => git('stage', path, [diff.file.path]))}
              onUnstageFile={() => run('Unstaging…', () => git('unstage', path, [diff.file.path]))}
              onDiscardFile={() => discardFiles([diff.file])}
              onApplyHunk={(patch, cached, reverse) => run('Applying…', () => git('applyPatch', path, patch, cached, reverse))}
            />
          ) : (
            <CommitGraph
              items={graph.items}
              maxLanes={graph.maxLanes}
              refsBySha={refsBySha}
              headSha={info?.head ?? null}
              detached={!!info?.head && !info?.branch}
              selected={selected}
              onSelect={(sha) => {
                setSelected(sha);
                setCompareSha(null);
              }}
              compareSha={compareSha}
              onCompare={(sha) => {
                if (!selected || selected === WIP || selected === sha) return setSelected(sha);
                setCompareSha(sha);
              }}
              onSearch={(mode, q) => git<string[]>('searchCommits', path, mode, q)}
              filterNote={
                filterActive && (
                  <>
                    {graphFilter.solo.length > 0 && <span>Solo: {graphFilter.solo.map(shortRef).join(', ')}</span>}
                    {graphFilter.hidden.length > 0 && <span>Hidden: {graphFilter.hidden.map(shortRef).join(', ')}</span>}
                    <a className="link" onClick={() => setGraphFilter(NO_FILTER)}>
                      Show all
                    </a>
                  </>
                )
              }
              onRowMenu={rowMenu}
              onRefMenu={refMenu}
              onRefDoubleClick={checkoutRef}
              scrollTarget={scrollTarget}
              wip={wipCounts}
              findOpen={findOpen}
              setFindOpen={setFindOpen}
            />
          )}
        </div>
        <Splitter onDrag={(dx) => setRightW((w) => clamp(w - dx, 280, 720))} />
        <div className="right" style={{ width: rightW }}>
          {info && stagingVisible ? (
            <StagingPanel
              repo={path}
              status={status}
              info={info}
              summary={summary}
              setSummary={setSummary}
              description={description}
              setDescription={setDescription}
              amend={amend}
              setAmend={toggleAmend}
              activePath={diff?.kind === 'wip' ? diff.file.path : null}
              onOpenDiff={(f, staged) => {
                setFileView(null);
                setDiff({ kind: 'wip', file: f, staged });
              }}
              onStage={(files) => run('Staging…', () => git('stage', path, files.map((f) => f.path)))}
              onUnstage={(files) => run('Unstaging…', () => git('unstage', path, files.map((f) => f.path)))}
              onStageAll={() => run('Staging…', () => git('stageAll', path))}
              onUnstageAll={() => run('Unstaging…', () => git('unstageAll', path))}
              onDiscardAll={discardAll}
              onFileMenu={fileMenu}
              onCommit={commit}
              onResolve={(f, side) => run('Resolving…', () => git('resolve', path, f.path, side))}
              onMarkResolved={(f) => run('Staging…', () => git('stage', path, [f.path]))}
              onAbort={() => info.state && run('Aborting…', () => git('abort', path, info.state), 'Aborted')}
              onContinue={() => info.state && run('Continuing…', () => git('continueOp', path, info.state))}
              onSkip={() => run('Skipping…', () => git('skipRebase', path))}
            />
          ) : compare ? (
            <ComparePanel
              repo={path}
              base={compare.base}
              target={compare.target}
              version={version}
              activePath={diff?.kind === 'commit' && diff.sha === compare.target.sha && diff.parent === compare.base.sha ? diff.file.path : null}
              onOpenDiff={(f) => {
                setFileView(null);
                setDiff({ kind: 'commit', sha: compare.target.sha, parent: compare.base.sha, file: f });
              }}
              onSelectSha={selectSha}
              onFileMenu={(e, f) => commitFileMenu(e, f, compare.target.sha)}
              onSwap={() => {
                setSelected(compareSha);
                setCompareSha(selected);
                setDiff(null);
              }}
              onClose={() => {
                setCompareSha(null);
                setDiff(null);
              }}
            />
          ) : selected && selected !== WIP ? (
            <CommitPanel
              repo={path}
              sha={selected}
              version={version}
              activePath={diff?.kind === 'commit' && diff.sha === selected ? diff.file.path : null}
              onOpenDiff={(d: CommitDetails, f) => {
                setFileView(null);
                setDiff({ kind: 'commit', sha: d.sha, parent: d.parents[0], file: f });
              }}
              onSelectSha={selectSha}
              onFileMenu={(e, f) => commitFileMenu(e, f, selected)}
              toast={ui.toast}
            />
          ) : (
            <div className="panel-empty">Select a commit to see its details</div>
          )}
        </div>
      </div>
      {rebaseEditor && (
        <InteractiveRebase
          branch={info?.branch ?? 'HEAD'}
          base={rebaseEditor.base}
          commits={rebaseEditor.commits}
          onCancel={() => setRebaseEditor(null)}
          onStart={runInteractiveRebase}
        />
      )}
      {paletteOpen && <CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
