import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Commit, CommitDetails, DiffTarget, FileChange, OpResult, Ref, RepoInfo, Stash, Status } from '../types';
import { WIP } from '../types';
import { api, basename, cleanError, git, joinPath } from '../api';
import { computeGraph } from '../lib/graph';
import { parseTrack } from '../lib/format';
import { Splitter, useUI, type MenuItem } from './ui';
import { Toolbar, PULL_LABELS, type PullMode } from './Toolbar';
import { Sidebar } from './Sidebar';
import { CommitGraph, type WipCounts } from './CommitGraph';
import { CommitPanel, StagingPanel } from './RightPanel';
import { DiffView } from './DiffView';

interface Props {
  path: string;
  active: boolean;
  command: { name: string; n: number } | null;
  onRepoMenu: (e: React.MouseEvent) => void;
}

const EMPTY_STATUS: Status = { staged: [], unstaged: [], conflicted: [] };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isOpResult = (r: unknown): r is OpResult => !!r && typeof r === 'object' && 'conflict' in r;

export function RepoView({ path, active, command, onRepoMenu }: Props) {
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
  const seq = useRef(0);
  const didInitialSelect = useRef(false);

  // ---------- loading ----------
  const refreshAll = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [i, c, r, s, st] = await Promise.all([
        git<RepoInfo>('info', path),
        git<Commit[]>('log', path),
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
      setFindOpen(true);
    }
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

  const selectSha = (sha: string) => {
    setSelected(sha);
    setDiff(null);
    setScrollTarget({ sha, n: Date.now() });
  };

  const checkoutRef = (r: Ref) => {
    if (r.type === 'local') {
      if (r.isHead) return;
      run(`Checking out ${r.name}…`, () => git('checkout', path, r.name), `Checked out ${r.name}`);
    } else if (r.type === 'remote') {
      run(`Checking out ${r.name}…`, () => git('checkoutRemote', path, r.name), `Checked out ${r.name.split('/').slice(1).join('/')}`);
    } else {
      run(`Checking out ${r.name}…`, () => git('checkout', path, r.name), `Checked out tag ${r.name} (detached HEAD)`);
    }
  };

  const createBranch = async (start?: string) => {
    const name = await ui.prompt({ title: 'Create branch', label: 'Branch name', placeholder: 'feature/my-branch', confirmText: 'Create Branch' });
    if (!name) return;
    run('Creating branch…', () => git('createBranch', path, name.replace(/\s+/g, '-'), start, true), `Created and checked out ${name}`);
  };

  const deleteBranch = async (r: Ref) => {
    if (!(await ui.confirm({ title: 'Delete branch', message: <>Delete local branch <b>{r.name}</b>?</>, confirmText: 'Delete', danger: true }))) return;
    setBusy('Deleting branch…');
    try {
      await git('deleteBranch', path, r.name, false);
      ui.toast(`Deleted ${r.name}`, 'success');
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
            ui.toast(`Deleted ${r.name}`, 'success');
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
    if (name && name !== r.name) run('Renaming…', () => git('renameBranch', path, r.name, name), `Renamed to ${name}`);
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

  const pull = (mode: PullMode = pullMode) => run('Pulling…', () => git('pull', path, mode), 'Pulled');
  const fetchAll = () => run('Fetching…', () => git('fetch', path), 'Fetched all remotes');

  const stash = async () => {
    if (!totalChanges) return ui.toast('No local changes to stash', 'info');
    await run('Stashing…', () => git('stash', path, summary.trim() || undefined), 'Stashed changes');
    setSummary('');
    setDescription('');
  };
  const pop = () => run('Popping stash…', () => git('stashPop', path), 'Popped stash');

  const commit = async () => {
    const ok = await run(amend ? 'Amending…' : 'Committing…', () => git('commit', path, summary.trim(), description, amend).then(() => true));
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
      { label: 'Checkout this commit', hint: 'detached', onClick: () => run('Checking out…', () => git('checkout', path, c.sha), `Checked out ${short}`) },
      'sep',
      { label: `Cherry pick commit`, onClick: () => run('Cherry-picking…', () => git('cherryPick', path, c.sha), `Cherry-picked ${short}`) },
      { label: `Revert commit`, onClick: () => run('Reverting…', () => git('revert', path, c.sha, c.parents.length > 1), `Reverted ${short}`) },
      'sep',
      { label: `Reset ${cur} to this commit — Soft`, onClick: () => resetTo(c.sha, 'soft') },
      { label: `Reset ${cur} to this commit — Mixed`, onClick: () => resetTo(c.sha, 'mixed') },
      { label: `Reset ${cur} to this commit — Hard`, onClick: () => resetTo(c.sha, 'hard'), danger: true },
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
    run('Resetting…', () => git('reset', path, sha, mode), `Reset (${mode}) to ${sha.slice(0, 7)}`);
  };

  const createTag = async (sha: string, annotated = false) => {
    const name = await ui.prompt({ title: annotated ? 'Create annotated tag' : 'Create tag', label: 'Tag name', placeholder: 'v1.0.0', confirmText: 'Create Tag' });
    if (!name) return;
    let message: string | null = null;
    if (annotated) {
      message = await ui.prompt({ title: 'Tag message', label: 'Message', multiline: true, confirmText: 'Create Tag' });
      if (!message) return;
    }
    run('Tagging…', () => git('createTag', path, name, sha, message), `Created tag ${name}`);
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
        items.push({ label: `Merge ${r.name} into ${cur}`, onClick: () => run('Merging…', () => git('merge', path, r.name), `Merged ${r.name} into ${cur}`) });
        items.push({ label: `Rebase ${cur} onto ${r.name}`, onClick: () => run('Rebasing…', () => git('rebase', path, r.name), `Rebased ${cur} onto ${r.name}`) });
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
        items.push({ label: `Merge ${r.name} into ${cur}`, onClick: () => run('Merging…', () => git('merge', path, r.name), `Merged ${r.name} into ${cur}`) });
        items.push({ label: `Rebase ${cur} onto ${r.name}`, onClick: () => run('Rebasing…', () => git('rebase', path, r.name), `Rebased ${cur} onto ${r.name}`) });
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
          if (await ui.confirm({ title: 'Delete tag', message: <>Delete local tag <b>{r.name}</b>?</>, confirmText: 'Delete', danger: true }))
            run('Deleting tag…', () => git('deleteTag', path, r.name), `Deleted tag ${r.name}`);
        },
      });
      items.push({ label: 'Copy tag name', onClick: () => copy(r.name) });
    }
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
    items.push({ label: 'Open file', onClick: () => api.openPath(full) });
    items.push({ label: 'Show in folder', onClick: () => api.showItem(full) });
    items.push({ label: 'Copy file path', onClick: () => copy(f.path) });
    ui.menu(e, items);
  };

  const commitFileMenu = (e: React.MouseEvent, f: FileChange) => {
    const full = joinPath(path, f.path);
    ui.menu(e, [
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
          {diff ? (
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
              onSelect={(sha) => setSelected(sha)}
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
              onOpenDiff={(f, staged) => setDiff({ kind: 'wip', file: f, staged })}
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
          ) : selected && selected !== WIP ? (
            <CommitPanel
              repo={path}
              sha={selected}
              version={version}
              activePath={diff?.kind === 'commit' && diff.sha === selected ? diff.file.path : null}
              onOpenDiff={(d: CommitDetails, f) => setDiff({ kind: 'commit', sha: d.sha, parent: d.parents[0], file: f })}
              onSelectSha={selectSha}
              onFileMenu={commitFileMenu}
              toast={ui.toast}
            />
          ) : (
            <div className="panel-empty">Select a commit to see its details</div>
          )}
        </div>
      </div>
    </div>
  );
}
