import { ChevronDown, Cloud } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Author,
  BisectState,
  CiStatus,
  Commit,
  CommitDetails,
  DiffTarget,
  FileChange,
  GhStatus,
  GraphFilter,
  LfsInfo,
  OpResult,
  PullRequest,
  RebaseCommit,
  Ref,
  RepoInfo,
  RepoStats,
  Stash,
  Status,
  Submodule,
  Worktree,
} from '../types';
import { WIP } from '../types';
import { api, basename, cleanError, git, joinPath } from '../api';
import { computeGraph, laneColor } from '../lib/graph';
import { parseTrack } from '../lib/format';
import { Splitter, useUI, type MenuItem } from './ui';
import { Toolbar, PULL_LABELS, type Crumb, type PullMode } from './Toolbar';
import { Sidebar } from './Sidebar';
import { CommitGraph, type WipCounts } from './CommitGraph';
import { CommitPanel, ComparePanel, StagingPanel } from './RightPanel';
import { PrPanel } from './PrPanel';
import { DiffView } from './DiffView';
import { FileHistory, type FileViewMode } from './FileHistory';
import { InteractiveRebase, type RebaseStep } from './InteractiveRebase';
import { ConflictEditor } from './ConflictEditor';
import { conflictSides, isDeletion } from '../lib/conflicts';
import { CreatePrDialog, type NewPr } from './CreatePrDialog';
import { RecoverDialog } from './RecoverDialog';
import { GitignoreDialog } from './GitignoreDialog';
import { BisectBanner } from './BisectBanner';
import { cleanTemplate, saveSettings, useSettings, shortcut } from '../lib/settings';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import {
  branchCreated,
  branchRenamed,
  checkoutMove,
  headMove,
  refCreated,
  refDeleted,
  refsDeleted,
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
  onOpenRepo: (path: string) => void;
  onStats: (stats: RepoStats) => void;
}

const EMPTY_STATUS: Status = { staged: [], unstaged: [], conflicted: [] };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isOpResult = (r: unknown): r is OpResult => !!r && typeof r === 'object' && 'conflict' in r;
const HISTORY_LIMIT = 50;
// Layout: the app rail, the graph's minimum width, both splitters, and the side panels' minimums.
const RAIL_W = 52;
const CENTER_MIN = 300;
const SPLITTERS = 10;
const SIDE_MIN = 170;
const RIGHT_MIN = 260;

interface PushReport {
  ref: string;
  count: number;
  authors: string[];
  isNew: boolean;
}
const LOG_PAGE = 5000;
const NO_FILTER: GraphFilter = { solo: [], hidden: [] };
const shortRef = (full: string) => full.replace(/^refs\/(heads|remotes|tags)\//, '');
// A branch's name without its remote prefix.
const branchName = (r: Ref) => (r.type === 'remote' ? r.name.split('/').slice(1).join('/') : r.name);
const splitMessage = (m: string) => {
  const [first, ...rest] = m.split('\n');
  return { summary: first, description: rest.join('\n').trim() };
};

function loadFilter(path: string): GraphFilter {
  try {
    const f = JSON.parse(localStorage.getItem(`graphFilter:${path}`) ?? '');
    if (Array.isArray(f.solo) && Array.isArray(f.hidden)) return f;
  } catch {}
  return NO_FILTER;
}

export function RepoView({ path, active, command, onRepoMenu, appCommands, onOpenRepo, onStats }: Props) {
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
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('sideW')) || 230);
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem('rightW')) || 340);
  // In narrow windows the side panels give up width so the graph keeps at least 300px.
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const room = winW - RAIL_W - CENTER_MIN - SPLITTERS;
  const squeeze = sideW + rightW > room ? room / (sideW + rightW) : 1;
  const sideShown = Math.max(SIDE_MIN, Math.floor(sideW * squeeze));
  const rightShown = Math.max(RIGHT_MIN, Math.floor(rightW * squeeze));
  const settings = useSettings();
  const pullMode = settings.pullMode;
  const [template, setTemplate] = useState('');
  const [coAuthors, setCoAuthors] = useState<Author[]>([]);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  // Counts PR list loads, so an open PR panel reloads along with the list.
  const [prsLoaded, setPrsLoaded] = useState(0);
  const [ci, setCi] = useState<Record<string, CiStatus>>({});
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [submodules, setSubmodules] = useState<Submodule[]>([]);
  const [lfs, setLfs] = useState<LfsInfo | null>(null);
  // The pull request shown in the right panel, and the commit it was opened at.
  const [openPr, setOpenPr] = useState<{ number: number; sha: string } | null>(null);
  const [prDraft, setPrDraft] = useState<{ head: string; needsPush: boolean; base: string; title: string } | null>(null);
  const [history, setHistory] = useState<{ undo: UndoEntry[]; redo: UndoEntry[] }>({ undo: [], redo: [] });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fileView, setFileView] = useState<{ path: string; mode: FileViewMode; rev?: string } | null>(null);
  const [compareSha, setCompareSha] = useState<string | null>(null);
  const [graphFilter, setGraphFilter] = useState<GraphFilter>(() => loadFilter(path));
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [bisect, setBisect] = useState<BisectState | null>(null);
  const [gitignoreOpen, setGitignoreOpen] = useState(false);
  const [sideFocus, setSideFocus] = useState<{ key: string; n: number } | null>(null);
  const [rebaseEditor, setRebaseEditor] = useState<{ base: string; commits: RebaseCommit[] } | null>(null);
  // A stash apply / pop that stopped on conflicts. `staged` is what was staged before it, so only the
  // stash's own changes are unstaged once the last conflict is resolved.
  const [stashConflict, setStashConflict] = useState<{ ref: string; sha: string; pop: boolean; staged: string[] } | null>(null);
  const filterRef = useRef(graphFilter);
  filterRef.current = graphFilter;
  // How many commits the graph loads; "Load more" raises it.
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const limitRef = useRef(logLimit);
  limitRef.current = logLimit;
  const seq = useRef(0);
  const didInitialSelect = useRef(false);

  // ---------- loading ----------
  const refreshAll = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [i, c, r, s, st] = await Promise.all([
        git<RepoInfo>('info', path),
        git<Commit[]>('log', path, limitRef.current, filterRef.current),
        git<Ref[]>('refs', path),
        git<Stash[]>('stashes', path),
        git<Status>('status', path),
      ]);
      // Worktrees and submodules are extras; a failure there shouldn't break loading the repo.
      const [wt, sm] = await Promise.all([git<Worktree[]>('worktrees', path).catch(() => []), git<Submodule[]>('submodules', path).catch(() => [])]);
      if (n !== seq.current) return;
      setWorktrees(wt);
      setSubmodules(sm);
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

  // ---------- GitHub ----------
  const remotesKey = info?.remotes.join(',') ?? '';
  const loadPrs = useCallback(async () => {
    // CI results come along with pull requests; a repo without Actions just gets no dots.
    git<Record<string, CiStatus>>('ghCiStatus', path)
      .then(setCi)
      .catch(() => setCi({}));
    try {
      setPrs(await git<PullRequest[]>('ghPrs', path));
      setPrsLoaded((n) => n + 1);
    } catch (e) {
      setGh({ ok: false, reason: cleanError(e) });
    }
  }, [path]);

  useEffect(() => {
    if (!info) return;
    let alive = true;
    git<GhStatus>('ghStatus', path).then((st) => {
      if (!alive) return;
      setGh(st);
      if (!st.ok) return setPrs([]);
      loadPrs();
      git<string | null>('ghDefaultBranch', path).then((b) => alive && setDefaultBranch(b));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, remotesKey, !!info, loadPrs]);

  // Tell the user when someone else pushed, in-app and (when the window isn't focused) via the OS.
  const notifyRef = useRef(settings.notifyPushes);
  notifyRef.current = settings.notifyPushes;
  const announcePushes = useCallback(
    (report: PushReport[] | undefined) => {
      if (!report?.length || !notifyRef.current) return;
      const who = (a: string[]) => (a.length > 2 ? `${a[0]} and ${a.length - 1} others` : a.join(' and '));
      const msgs = report.map((r) =>
        r.isNew
          ? `${who(r.authors)} pushed a new branch ${r.ref} (${r.count} commit${r.count === 1 ? '' : 's'})`
          : `${who(r.authors)} pushed ${r.count} commit${r.count === 1 ? '' : 's'} to ${r.ref}`
      );
      const body = msgs.length > 3 ? [...msgs.slice(0, 3), `…and ${msgs.length - 3} more branches`].join('\n') : msgs.join('\n');
      ui.toast(body, 'info');
      if (!document.hasFocus() && 'Notification' in window) new Notification(basename(path), { body });
    },
    [ui, path]
  );

  // Background fetch on the interval from Settings.
  const hasRemotes = !!info?.remotes.length;
  const ghOk = !!gh?.ok;
  useEffect(() => {
    if (!hasRemotes || !settings.autoFetchMinutes) return;
    const t = setInterval(() => {
      git<PushReport[]>('fetch', path)
        .then((report) => {
          announcePushes(report);
          return refreshAll();
        })
        .catch(() => {});
      if (ghOk) loadPrs();
    }, settings.autoFetchMinutes * 60 * 1000);
    return () => clearInterval(t);
  }, [hasRemotes, path, refreshAll, settings.autoFetchMinutes, ghOk, loadPrs, announcePushes]);

  useEffect(() => {
    git<LfsInfo>('lfsInfo', path)
      .then(setLfs)
      .catch(() => setLfs(null));
  }, [path]);

  // ---------- commit message template ----------
  // git's commit.template wins over the app-wide one from Settings.
  useEffect(() => {
    git<string | null>('commitTemplate', path)
      .catch(() => null)
      .then((t) => setTemplate(cleanTemplate(t) || cleanTemplate(settings.commitTemplate)));
  }, [path, settings.commitTemplate]);

  const firstLimit = useRef(true);
  useEffect(() => {
    if (firstLimit.current) firstLimit.current = false;
    else refreshAll();
  }, [logLimit, refreshAll]);

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

  // Each commit's lane color, so sidebar branches match their line in the graph.
  const laneColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const { commit, graph: g } of graph.items) m.set(commit.sha, laneColor(g.afterColors[g.col] ?? g.beforeColors[g.col] ?? g.col));
    return m;
  }, [graph]);

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
    const unstaged = new Set([...status.unstaged, ...status.conflicted].map((f) => f.path)).size;
    return { modified, added, deleted, conflicted: status.conflicted.length, staged: status.staged.length, unstaged };
  }, [status]);

  const currentRef = refs.find((r) => r.type === 'local' && r.isHead);
  const track = parseTrack(currentRef?.track);
  const locals = refs.filter((r) => r.type === 'local');
  const remoteBranches = refs.filter((r) => r.type === 'remote');

  // ---------- selection housekeeping ----------
  useEffect(() => {
    if (!info) return;
    if (!didInitialSelect.current) {
      didInitialSelect.current = true;
      setSelected(showWip ? WIP : info.head);
      if (info.head && !showWip) setScrollTarget({ sha: info.head, n: Date.now() });
      return;
    }
    // After a conflicting stash apply the working copy stays selected even if this status predates the
    // conflicts (a refresh from the file watcher can overtake the one the apply waited for).
    if (selected === WIP && !showWip && !stashConflict) setSelected(info.head);
    if (!selected && showWip) setSelected(WIP);
  }, [info, showWip, selected, stashConflict]);

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

  // The commit box counts as untouched when it's empty or still holds the unedited template.
  const appliedTemplate = useRef('');
  const isPristine = () => {
    if (!summary.trim() && !description.trim()) return true;
    if (!appliedTemplate.current) return false;
    const t = splitMessage(appliedTemplate.current);
    return summary === t.summary && description === t.description;
  };
  const resetMessage = () => {
    const t = splitMessage(template);
    setSummary(template ? t.summary : '');
    setDescription(template ? t.description : '');
    appliedTemplate.current = template;
  };
  useEffect(() => {
    if (isPristine() && !info?.state) resetMessage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // Prefill the commit message while a merge / cherry-pick / revert is in progress.
  const prevState = useRef<string | null>(null);
  useEffect(() => {
    const st = info?.state ?? null;
    if (st && st !== prevState.current && info?.mergeMsg && isPristine()) {
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
    if (command.name === 'view-history') showHistory();
    if (command.name === 'view-changes') showChanges();
    if (command.name === 'view-prs') {
      setSideFocus({ key: 'prs', n: Date.now() });
      if (prs.length === 1) selectPr(prs[0]);
    }
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
    if (dir === 'undo' && entry.message && isPristine()) {
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

  const mergeRef = (name: string, cur = info?.branch ?? 'HEAD') => {
    tracked('Merging…', () => git('merge', path, name), `Merged ${name} into ${cur}`, (b, a) => headMove(`Merge ${name} into ${cur}`, b, a, 'keep'));
  };
  const rebaseOnto = (name: string, cur = info?.branch ?? 'HEAD') => {
    tracked('Rebasing…', () => git('rebase', path, name), `Rebased ${cur} onto ${name}`, (b, a) => headMove(`Rebase ${cur} onto ${name}`, b, a, 'keep'));
  };
  const fetchAll = async () => {
    const report = await run('Fetching…', () => git<PushReport[]>('fetch', path), 'Fetched all remotes');
    announcePushes(report);
    if (gh?.ok) loadPrs();
  };

  // Checks out `branch`, then runs `then` only if the checkout actually happened.
  const checkoutThen = async (branch: string, then: () => void) => {
    await tracked(`Checking out ${branch}…`, () => git('checkout', path, branch), undefined, (b, a) => checkoutMove(`Checkout ${branch}`, b, a));
    if ((await headState())?.branch === branch) then();
  };

  // ---------- stale branches ----------
  const pruneGone = async () => {
    const gone = locals.filter((r) => r.track === 'gone' && !r.isHead);
    if (!gone.length) return ui.toast('No local branches have a deleted remote branch.', 'info');
    const list = (rs: Ref[]) => (
      <ul className="confirm-list">
        {rs.map((r) => (
          <li key={r.full}>{r.name}</li>
        ))}
      </ul>
    );
    if (
      !(await ui.confirm({
        title: 'Delete stale branches',
        message: <>These local branches track remote branches that were deleted:{list(gone)}</>,
        confirmText: `Delete ${gone.length}`,
        danger: true,
      }))
    )
      return;
    const state = await headState();
    const deleted: Ref[] = [];
    const unmerged: Ref[] = [];
    const del = async (rs: Ref[], force: boolean) => {
      for (const r of rs) {
        try {
          await git('deleteBranch', path, r.name, force);
          deleted.push(r);
        } catch (e) {
          if (!force && /not fully merged/.test(cleanError(e))) unmerged.push(r);
          else ui.toast(cleanError(e), 'error');
        }
      }
    };
    setBusy('Deleting branches…');
    await del(gone, false);
    setBusy(null);
    if (
      unmerged.length &&
      (await ui.confirm({
        title: 'Some branches have unmerged commits',
        message: <>These branches have commits that aren't merged into the current branch. Delete them anyway?{list(unmerged)}</>,
        confirmText: 'Force Delete',
        danger: true,
      }))
    )
      await del(unmerged, true);
    if (deleted.length) {
      if (state) record(refsDeleted(`Delete ${deleted.length} stale branch${deleted.length === 1 ? '' : 'es'}`, deleted, state));
      ui.toast(`Deleted ${deleted.map((r) => r.name).join(', ')}`, 'success');
    }
    refreshAll();
  };

  // ---------- pull requests ----------
  const prFor = (r: Ref) => prs.find((p) => !p.fork && p.head === branchName(r));

  const openCreatePr = (r: Ref, base?: string) => {
    const head = branchName(r);
    const local = r.type === 'local' ? r : locals.find((l) => l.name === head);
    const t = parseTrack(local?.track);
    const needsPush = !!local && (!local.upstream || t.gone || t.ahead > 0);
    const tip = commits.find((c) => c.sha === (local ?? r).sha);
    setPrDraft({
      head,
      needsPush,
      base: base ?? defaultBranch ?? (refs.some((x) => x.name === 'main') ? 'main' : 'master'),
      title: tip?.subject ?? head,
    });
  };

  const createPr = async (pr: NewPr) => {
    if (!prDraft) return;
    const { head, needsPush } = prDraft;
    setPrDraft(null);
    const url = await run(
      'Creating pull request…',
      async () => {
        if (needsPush) await git('push', path, head, false);
        return git<string>('ghCreatePr', path, head, pr.base, pr.title, pr.body, pr.draft);
      },
      'Created pull request'
    );
    if (url) {
      window.open(url);
      loadPrs();
    }
  };

  const checkoutPr = (pr: PullRequest) =>
    tracked(`Checking out #${pr.number}…`, () => git('ghCheckoutPr', path, pr.number), `Checked out #${pr.number}`, (b, a) =>
      checkoutMove(`Checkout pull request #${pr.number}`, b, a)
    );

  // Opens the PR's panel and shows its tip in the graph. A PR opened elsewhere (e.g. by a cloud session) may not be fetched yet, so fetch it first.
  const selectPr = async (pr: PullRequest) => {
    setOpenPr({ number: pr.number, sha: pr.sha });
    if (!commits.some((c) => c.sha === pr.sha)) {
      if (pr.fork) return ui.toast(`#${pr.number} comes from a fork, so its branch isn't here. Double-click it to check it out.`, 'info');
      if (!(await run(`Fetching ${pr.head}…`, () => git('fetch', path)))) return;
    }
    selectSha(pr.sha);
  };

  // Selecting any other commit closes the PR panel.
  useEffect(() => {
    setOpenPr((p) => (p && p.sha === selected ? p : null));
  }, [selected]);

  // Runs a PR action from the panel, then refreshes the PR list (its state, checks or branch may have changed).
  const prAct = async (label: string, fn: () => Promise<unknown>, success: string) => {
    const ok = await run(label, async () => (await fn(), true), success);
    loadPrs();
    return !!ok;
  };

  const prMenu = (e: React.MouseEvent, pr: PullRequest) =>
    ui.menu(e, [
      { label: 'Show pull request', onClick: () => selectPr(pr) },
      { label: `Checkout #${pr.number}`, onClick: () => checkoutPr(pr) },
      'sep',
      { label: 'Open on GitHub', onClick: () => window.open(pr.url) },
      { label: 'Copy link', onClick: () => copy(pr.url) },
    ]);

  // ---------- drag a branch onto another ----------
  const refDrop = (e: React.DragEvent, sourceFull: string, target: Ref) => {
    const source = refs.find((r) => r.full === sourceFull);
    if (!source || source.type === 'tag' || target.type === 'tag' || source.full === target.full) return;
    const s = source.name;
    const t = target.name;
    const items: MenuItem[] = [];
    if (target.type === 'local') {
      if (target.isHead) items.push({ label: `Merge ${s} into ${t}`, onClick: () => mergeRef(s, t) });
      else items.push({ label: `Merge ${s} into ${t}`, hint: `checks out ${t}`, onClick: () => checkoutThen(t, () => mergeRef(s, t)) });
    }
    if (source.type === 'local') {
      if (source.isHead) items.push({ label: `Rebase ${s} onto ${t}`, onClick: () => rebaseOnto(t, s) });
      else items.push({ label: `Rebase ${s} onto ${t}`, hint: `checks out ${s}`, onClick: () => checkoutThen(s, () => rebaseOnto(t, s)) });
    }
    if (gh?.ok && branchName(source) !== branchName(target)) {
      items.push('sep', { label: `Create pull request: ${branchName(source)} → ${branchName(target)}`, onClick: () => openCreatePr(source, branchName(target)) });
    }
    if (items.length) ui.menu(e, items);
  };

  // ---------- worktrees / submodules / LFS ----------
  // Worktree paths are absolute; submodule paths are relative to this repo.
  const openRepoPath = (p: string) => onOpenRepo(/^([A-Za-z]:)?[\\/]/.test(p) ? p : joinPath(path, p));

  const addWorktree = async (r: Ref) => {
    const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, '');
    const suggestion = joinPath(parent, `${basename(path)}-${r.name.replace(/[\\/]/g, '-')}`);
    const dir = await ui.prompt({ title: `Check out ${r.name} in a new worktree`, label: 'Folder for the new worktree', initial: suggestion, confirmText: 'Create Worktree' });
    if (!dir) return;
    const made = await run('Creating worktree…', () => git<string>('addWorktree', path, dir, r.name), `Checked out ${r.name} in ${basename(dir)}`);
    if (made) onOpenRepo(made);
  };

  const worktreeMenu = (e: React.MouseEvent, w: Worktree) =>
    ui.menu(e, [
      { label: 'Open in new tab', disabled: w.current, onClick: () => openRepoPath(w.path) },
      { label: 'Show in folder', onClick: () => api.openPath(w.path) },
      { label: 'Copy path', onClick: () => copy(w.path) },
      'sep',
      ...(w.prunable ? [{ label: 'Prune missing worktrees', onClick: () => run('Pruning…', () => git('pruneWorktrees', path), 'Pruned worktrees') }] : []),
      {
        label: 'Remove worktree…',
        danger: true,
        disabled: w.current,
        onClick: async () => {
          if (!(await ui.confirm({ title: 'Remove worktree', message: <>Remove the worktree at <b>{w.path}</b>? The folder is deleted; the branch stays.</>, confirmText: 'Remove', danger: true })))
            return;
          try {
            await git('removeWorktree', path, w.path, false);
            ui.toast('Removed worktree', 'success');
          } catch (err) {
            const msg = cleanError(err);
            if (/modified or untracked|contains modified/.test(msg)) {
              if (await ui.confirm({ title: 'Worktree has changes', message: 'It has uncommitted changes. Remove it anyway? They will be lost.', confirmText: 'Force Remove', danger: true }))
                await run('Removing worktree…', () => git('removeWorktree', path, w.path, true), 'Removed worktree');
            } else ui.toast(msg, 'error');
          }
          refreshAll();
        },
      },
    ]);

  const submoduleMenu = (e: React.MouseEvent, s: Submodule) =>
    ui.menu(e, [
      s.state === 'uninitialized'
        ? { label: 'Initialize and clone', onClick: () => run('Cloning submodule…', () => git('updateSubmodules', path, s.path), `Initialized ${s.path}`) }
        : { label: 'Update to recorded commit', onClick: () => run('Updating submodule…', () => git('updateSubmodules', path, s.path), `Updated ${s.path}`) },
      { label: 'Open in new tab', disabled: s.state === 'uninitialized', onClick: () => openRepoPath(s.path) },
      'sep',
      { label: 'Update all submodules', onClick: () => run('Updating submodules…', () => git('updateSubmodules', path), 'Updated submodules') },
      { label: 'Copy path', onClick: () => copy(s.path) },
    ]);

  // ---------- co-authors ----------
  const coAuthorMenu = async (e: React.MouseEvent) => {
    const pos = { clientX: e.clientX, clientY: e.clientY, anchor: e.currentTarget };
    const [all, me] = await Promise.all([
      git<Author[]>('authors', path).catch(() => [] as Author[]),
      git<string | null>('getConfig', path, 'user.email').catch(() => null),
    ]);
    const has = (a: Author) => coAuthors.some((c) => c.email === a.email);
    const toggle = (a: Author) => setCoAuthors((cs) => (cs.some((c) => c.email === a.email) ? cs.filter((c) => c.email !== a.email) : [...cs, a]));
    const seen = new Set<string>();
    const candidates = all.filter((a) => a.email !== me && !seen.has(a.email) && seen.add(a.email)).slice(0, 20);
    ui.menu(pos, [
      ...candidates.map((a) => ({ label: `${has(a) ? '✓ ' : '   '}${a.name}`, hint: a.email, onClick: () => toggle(a) })),
      ...(candidates.length ? ['sep' as const] : []),
      {
        label: 'Add someone else…',
        onClick: async () => {
          const v = await ui.prompt({ title: 'Add co-author', label: 'Name and email', placeholder: 'Ada Lovelace <ada@example.com>', confirmText: 'Add' });
          const m = v?.match(/^(.+?)\s*<([^>]+)>$/);
          if (m) toggle({ name: m[1].trim(), email: m[2].trim() });
          else if (v) ui.toast('Use the form: Name <email>', 'error');
        },
      },
    ]);
  };

  const stash = async () => {
    if (!totalChanges) return ui.toast('No local changes to stash', 'info');
    const message = isPristine() ? undefined : summary.trim() || undefined;
    await run('Stashing…', () => git('stash', path, message), 'Stashed changes');
    resetMessage();
  };
  const pop = () => applyStash(undefined, true);

  // Applies or pops a stash, remembering it if it stops on conflicts (git keeps the stash then).
  const applyStash = async (ref: string | undefined, isPop: boolean) => {
    const s = ref ? stashes.find((x) => x.ref === ref) : stashes[0];
    const staged = status.staged.map((f) => f.path);
    const r = await run(
      isPop ? 'Popping stash…' : 'Applying stash…',
      () => git<OpResult>(isPop ? 'stashPop' : 'stashApply', path, ...(ref ? [ref] : [])),
      isPop ? 'Popped stash' : 'Applied stash'
    );
    if (r?.conflict) {
      if (s) setStashConflict({ ref: s.ref, sha: s.sha, pop: isPop, staged });
      // Straight to the conflicted files (status has been refreshed by now, so the working copy row exists).
      setFileView(null);
      setDiff(null);
      setCompareSha(null);
      setSelected(WIP);
    }
    return r;
  };

  // Once the stash's last conflict is resolved, leave its changes unstaged, the way a clean apply does,
  // and offer to drop a popped stash that git kept.
  const stashConflictSeen = useRef(false);
  useEffect(() => {
    if (!stashConflict) return;
    if (status.conflicted.length) {
      stashConflictSeen.current = true;
      return;
    }
    if (!stashConflictSeen.current) return;
    stashConflictSeen.current = false;
    const sc = stashConflict;
    setStashConflict(null);
    const files = status.staged.map((f) => f.path).filter((f) => !sc.staged.includes(f));
    (async () => {
      if (files.length) await run('Unstaging…', () => git('unstage', path, files));
      if (!sc.pop) return ui.toast(`Applied ${sc.ref}. Its changes are unstaged.`, 'success');
      ui.toast(`Conflicts resolved. The changes from ${sc.ref} are unstaged, and git kept the stash.`, 'success', {
        label: 'Drop the stash',
        onClick: async () => {
          // Stash indexes shift as stashes come and go, so find this one again by its commit.
          const now = (await git<Stash[]>('stashes', path).catch(() => [])).find((x) => x.sha === sc.sha);
          if (!now) return ui.toast(`${sc.ref} is already gone`, 'info');
          run('Dropping stash…', () => git('stashDrop', path, now.ref), `Dropped ${now.ref}`);
        },
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, stashConflict]);

  // What git's "ours" / "theirs" are for the conflicts in progress.
  const sides = useMemo(() => conflictSides(info, stashConflict && !info?.state ? stashConflict.ref : null), [info, stashConflict]);

  // Taking the upstream side of a whole file during a rebase drops the user's own change to it.
  const confirmDropsCommit = (file: string, upstream: boolean) =>
    !upstream ||
    info?.state !== 'rebase' ||
    ui.confirm({
      title: "Drop your commit's changes",
      message: (
        <>
          This drops your commit's changes to <b>{file}</b>.
        </>
      ),
      confirmText: 'Drop Changes',
      danger: true,
    });
  const takeSide = async (f: FileChange, side: 'ours' | 'theirs') => {
    if (!(await confirmDropsCommit(f.path, side === 'ours'))) return;
    return run('Resolving…', () => git('resolve', path, f.path, side), `Took ${sides[side].noun} for ${f.path}`);
  };
  // Keeping a file the user's commit deleted, or deleting one it changed or added, also drops their change.
  const keepConflictFile = async (f: FileChange) => {
    if (!(await confirmDropsCommit(f.path, f.conflict === 'deleted-by-them'))) return;
    return run('Resolving…', () => git('stage', path, [f.path]), `Kept ${f.path}`);
  };
  const deleteConflictFile = async (f: FileChange) => {
    if (!(await confirmDropsCommit(f.path, f.conflict === 'deleted-by-us' || f.conflict === 'added-by-them'))) return;
    return run('Resolving…', () => git('resolveDelete', path, f.path), `Deleted ${f.path}`);
  };

  const commit = async () => {
    // Like git, refuse a message that is just the untouched template.
    if (template && isPristine()) return ui.toast('Edit the commit message template before committing.', 'info');
    const msg = summary.trim();
    const trailers = coAuthors.map((a) => `Co-authored-by: ${a.name} <${a.email}>`).join('\n');
    const body = [description.trim(), trailers].filter(Boolean).join('\n\n');
    const full = [msg, body].filter(Boolean).join('\n\n');
    const ok = await tracked(
      amend ? 'Amending…' : 'Committing…',
      () => git('commit', path, msg, body, amend).then(() => true),
      undefined,
      (b, a) => {
        const e = headMove(`${amend ? 'Amend' : 'Commit'} "${msg}"`, b, a, 'soft');
        return e && { ...e, message: full };
      }
    );
    if (ok) {
      resetMessage();
      setCoAuthors([]);
      setAmend(false);
      setDiff(null);
    }
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && isPristine()) {
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

  const openInEditor = (file?: string, line?: number) =>
    api.openInEditor(path, file, line, settings.editor).catch((e) => ui.toast(cleanError(e), 'error'));

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

  // ---------- bisect ----------
  // If the repo is mid-bisect (e.g. started in a terminal), pick it up; drop the banner once it ends.
  useEffect(() => {
    if (info?.bisecting && !bisect) setBisect({ done: false });
    if (info && !info.bisecting && bisect) setBisect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.bisecting]);

  const startBisect = async (good: string) => {
    if (!info?.head) return;
    const r = await run('Starting bisect…', () => git<BisectState>('bisectStart', path, info.head, good));
    if (r) setBisect(r);
  };
  const markBisect = async (verdict: 'good' | 'bad' | 'skip', sha?: string) => {
    const r = await run('Bisecting…', () => git<BisectState>('bisectMark', path, verdict, sha));
    if (r) setBisect(r);
  };
  const stopBisect = async () => {
    await run('Ending bisect…', () => git('bisectReset', path), 'Bisect finished');
    setBisect(null);
  };

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

  // Rewrites one commit's message: an amend for the branch tip, otherwise a rebase that rewords just that commit.
  const editMessage = async (c: Commit) => {
    const short = c.sha.slice(0, 7);
    const cur = info?.branch ?? 'HEAD';
    const isHead = c.sha === info?.head;
    let current: string;
    let plan: RebaseCommit[] = [];
    try {
      // Check the rebase is possible before asking for a message.
      if (!isHead) plan = await git<RebaseCommit[]>('rebasePlan', path, c.parents[0]);
      current = (await git<CommitDetails>('commitDetails', path, c.sha)).message;
    } catch (e) {
      return ui.toast(cleanError(e), 'error');
    }
    const message = await ui.prompt({ title: `Edit message of ${short}`, label: 'Commit message', initial: current, multiline: true, confirmText: 'Save Message' });
    if (message === null || !message.trim() || message.trim() === current.trim()) return;
    if (isHead) {
      return tracked('Saving message…', () => git('rewordHead', path, message), `Edited message of ${short}`, (b, a) =>
        headMove(`Edit message of ${short}`, b, a, 'soft')
      );
    }
    const steps: RebaseStep[] = plan.map((p) => (p.sha === c.sha ? { sha: p.sha, action: 'reword', message } : { sha: p.sha, action: 'pick' }));
    return tracked('Saving message…', () => git('interactiveRebase', path, c.parents[0], steps), `Edited message of ${short}`, (b, a) =>
      headMove(`Edit message of ${short} on ${cur}`, b, a, 'keep')
    );
  };

  // ---------- context menus ----------
  const rowMenu = (e: React.MouseEvent, c: Commit) => {
    if (c.sha === WIP) {
      ui.menu(e, [
        { label: 'Stash all changes', onClick: stash },
        {
          label: 'Stash only staged changes',
          disabled: !status.staged.length,
          onClick: () => run('Stashing…', () => git('stash', path, undefined, undefined, true), 'Stashed staged changes'),
        },
        'sep',
        { label: 'Discard all changes', onClick: discardAll, danger: true },
        'sep',
        { label: 'Recover lost commits…', onClick: () => setRecoverOpen(true) },
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
      {
        label: 'Edit commit message…',
        // Older commits are reworded by rebasing onto their parent, which the very first commit doesn't have.
        disabled: !info?.branch || (c.sha !== info.head && !c.parents.length),
        onClick: () => editMessage(c),
      },
      { label: 'Compare with HEAD', disabled: !info?.head || c.sha === info?.head, onClick: () => compareWithHead(c.sha) },
      ...(bisect
        ? [
            { label: 'Bisect: mark this commit good', onClick: () => markBisect('good', c.sha) },
            { label: 'Bisect: mark this commit bad', onClick: () => markBisect('bad', c.sha) },
          ]
        : [{ label: 'Bisect: this commit was good, HEAD is bad', disabled: !info?.head || c.sha === info?.head, onClick: () => startBisect(c.sha) }]),
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
      const elsewhere = worktrees.find((w) => !w.current && w.branch === r.name);
      if (elsewhere) items.push({ label: `Open worktree for ${r.name}`, onClick: () => openRepoPath(elsewhere.path) });
      else if (!isCur) items.push({ label: 'Check out in new worktree…', onClick: () => addWorktree(r) });
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
    if (gh?.ok && r.type !== 'tag') {
      const pr = prFor(r);
      items.push('sep');
      if (pr) {
        items.push({ label: `Open pull request #${pr.number}`, onClick: () => window.open(pr.url) });
      } else if (branchName(r) !== defaultBranch) items.push({ label: 'Create pull request…', onClick: () => openCreatePr(r) });
    }
    if (r.type === 'local' && r.track === 'gone') {
      items.push('sep');
      items.push({ label: 'Delete branches whose remote is gone…', onClick: pruneGone });
    }
    items.push('sep');
    if (!r.isHead) items.push({ label: graphFilter.hidden.includes(r.full) ? 'Show in graph' : 'Hide in graph', onClick: () => toggleHidden(r) });
    items.push({ label: graphFilter.solo.includes(r.full) ? 'Unsolo' : 'Solo in graph', onClick: () => toggleSolo(r) });
    if (filterActive) items.push({ label: 'Show all branches', onClick: () => setGraphFilter(NO_FILTER) });
    ui.menu(e, items);
  };

  // Viewing a stash shows it in the commit panel with its own actions.
  const selectedStash = stashes.find((s) => s.sha === selected) ?? null;
  const stashAction = async (s: Stash, action: 'apply' | 'pop' | 'drop') => {
    if (action === 'apply') return applyStash(s.ref, false);
    if (action === 'pop') {
      await applyStash(s.ref, true);
      return showChanges();
    }
    if (await ui.confirm({ title: 'Delete stash', message: <>Delete <b>{s.message}</b>?</>, confirmText: 'Delete', danger: true })) {
      await run('Deleting stash…', () => git('stashDrop', path, s.ref), 'Deleted stash');
      if (info?.head) selectSha(info.head);
    }
  };

  const stashMenu = (e: React.MouseEvent, s: Stash) =>
    ui.menu(e, [
      { label: 'Apply stash', onClick: () => applyStash(s.ref, false) },
      { label: 'Pop stash', onClick: () => applyStash(s.ref, true) },
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
    if (f.status === 'U' && isDeletion(f.conflict)) {
      if (f.conflict !== 'both-deleted') items.push({ label: 'Keep file', onClick: () => keepConflictFile(f) });
      items.push({ label: 'Delete file', onClick: () => deleteConflictFile(f) });
    } else if (f.status === 'U') {
      items.push({ label: `Take ${sides.ours.label.toLowerCase()}`, onClick: () => takeSide(f, 'ours') });
      items.push({ label: `Take ${sides.theirs.label.toLowerCase()}`, onClick: () => takeSide(f, 'theirs') });
      items.push({ label: 'Mark resolved', onClick: () => run('Staging…', () => git('stage', path, [f.path])) });
    } else if (staged) items.push({ label: 'Unstage', onClick: () => run('Unstaging…', () => git('unstage', path, [f.path])) });
    else {
      items.push({ label: 'Stage', onClick: () => run('Staging…', () => git('stage', path, [f.path])) });
      items.push({ label: 'Discard changes', danger: true, onClick: () => discardFiles([f]) });
    }
    if (f.status !== 'U') items.push({ label: 'Stash changes to this file', onClick: () => run('Stashing…', () => git('stash', path, `Changes to ${f.path}`, [f.path]), `Stashed ${f.path}`) });
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
    if (f.status !== 'D') items.push({ label: 'Open in editor', onClick: () => openInEditor(f.path) });
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
      { label: 'Open in editor', onClick: () => openInEditor(f.path) },
      { label: 'Open file', onClick: () => api.openPath(full) },
      { label: 'Show in folder', onClick: () => api.showItem(full) },
      { label: 'Copy file path', onClick: () => copy(f.path) },
    ]);
  };

  const branchMenu = (e: React.MouseEvent) =>
    ui.menu(e, [
      ...locals.map((r) => ({ label: `${r.isHead ? '✓ ' : '   '}${r.name}`, onClick: () => checkoutRef(r) })),
      // Remote branches check out as a local tracking branch (or switch to it if one exists).
      ...(remoteBranches.length ? ['sep' as const] : []),
      ...remoteBranches.map((r) => ({ label: r.name, icon: <Cloud size={13} />, onClick: () => checkoutRef(r) })),
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
          saveSettings({ pullMode: m });
          pull(m);
        },
      })),
    ]);

  const closeFileView = useCallback(() => setFileView(null), []);
  const closePr = useCallback(() => setOpenPr(null), []);

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

    if (lastUndo) add('Edit', `Undo ${lastUndo.label}`, () => applyHistory('undo'), shortcut('Z'));
    if (lastRedo) add('Edit', `Redo ${lastRedo.label}`, () => applyHistory('redo'), shortcut('Z', true));
    add('Remote', 'Fetch all', fetchAll);
    for (const m of Object.keys(PULL_LABELS) as PullMode[]) add('Remote', PULL_LABELS[m], () => pull(m));
    add('Remote', 'Push', () => push());
    add('Remote', 'Add remote…', addRemote);
    add('Branch', 'Create branch…', () => createBranch());
    if (locals.some((r) => r.track === 'gone' && !r.isHead)) add('Branch', 'Delete branches whose remote is gone…', pruneGone);
    if (gh?.ok) {
      add('GitHub', 'Refresh pull requests', loadPrs);
      if (currentRef && !prFor(currentRef) && currentRef.name !== defaultBranch) add('GitHub', `Create pull request for ${currentRef.name}…`, () => openCreatePr(currentRef));
      for (const pr of prs) {
        add('GitHub', `Show #${pr.number} ${pr.title}`, () => selectPr(pr));
        add('GitHub', `Checkout #${pr.number} ${pr.title}`, () => checkoutPr(pr));
        add('GitHub', `Open #${pr.number} on GitHub`, () => window.open(pr.url));
      }
    }
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
    }, shortcut('F'));
    add('View', 'Refresh', refreshAll, shortcut('R'));
    if (filterActive) add('View', 'Show all branches in graph', () => setGraphFilter(NO_FILTER));
    if (compare) add('View', 'Stop comparing', () => setCompareSha(null));
    add('Repo', 'Open in terminal', () => api.openTerminal(path));
    add('Repo', 'Open in editor', () => openInEditor());
    add('Repo', 'Recover lost commits…', () => setRecoverOpen(true));
    add('Repo', 'Edit .gitignore…', () => setGitignoreOpen(true));
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
      add('Stash', `Apply ${s.ref}: ${s.message}`, () => applyStash(s.ref, false));
      add('Stash', `Pop ${s.ref}: ${s.message}`, () => applyStash(s.ref, true));
    }
    return [...cmds, ...appCommands];
  };

  // ---------- rail views, location trail, status ----------
  const showHistory = () => {
    setDiff(null);
    setFileView(null);
    setCompareSha(null);
    if (info?.head) selectSha(info.head);
  };
  const showChanges = () => {
    if (!showWip) return ui.toast('No uncommitted changes', 'info');
    setFileView(null);
    setDiff(null);
    setCompareSha(null);
    setSelected(WIP);
    setScrollTarget({ sha: WIP, n: Date.now() });
  };

  // While a diff or file view is open the header shows where you are, with a way back.
  const closeViews = () => {
    setDiff(null);
    setFileView(null);
  };
  let trail: Crumb[] | null = null;
  if (fileView) {
    trail = [
      { label: 'History', onClick: closeViews },
      { label: fileView.path, mono: true },
      { label: fileView.mode === 'blame' ? (fileView.rev ? `Blame at ${fileView.rev.slice(0, 7)}` : 'Blame') : 'File history' },
    ];
  } else if (diff) {
    trail = [
      { label: 'History', onClick: closeViews },
      diff.kind === 'wip'
        ? { label: 'Uncommitted changes', onClick: closeViews }
        : { label: diff.sha.slice(0, 7), mono: true, onClick: closeViews },
      { label: diff.file.path, mono: true },
    ];
  }

  // Short names of the changed files, for the uncommitted-changes row in the graph.
  const wipFiles = useMemo(() => {
    const names = new Set<string>();
    for (const f of [...status.conflicted, ...status.unstaged, ...status.staged]) names.add(f.path.split('/').pop()!);
    return [...names];
  }, [status]);

  // The rail badges and status bar live in the app shell; report what they show.
  const undoLabel = history.undo[history.undo.length - 1]?.label ?? null;
  useEffect(() => {
    if (!active) return;
    onStats({
      branch: info?.branch ?? (info?.head ? `detached ${info.head.slice(0, 7)}` : null),
      ahead: track.ahead,
      behind: track.behind,
      changes: totalChanges,
      prs: prs.length,
      fetchedAt: info?.fetchedAt ?? null,
      undoLabel,
      busy,
      view: selected === WIP || (!selected && showWip) ? 'changes' : 'history',
    });
  }, [active, info, track.ahead, track.behind, totalChanges, prs.length, undoLabel, busy, selected, showWip, onStats]);

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
      <div className="repo-main">
        <div className="side-wrap" style={{ width: sideShown }}>
          <div className="side-title">
            <button className="side-title-btn" onClick={onRepoMenu} title={path}>
              <span>{basename(path)}</span>
              <ChevronDown size={12} />
            </button>
          </div>
          <Sidebar
            focus={sideFocus}
            selected={selected}
            refs={refs}
            stashes={stashes}
            remotes={info?.remotes ?? []}
            filter={graphFilter}
            laneColors={laneColors}
            prs={prs}
            gh={gh}
            onPrClick={selectPr}
            onPrDoubleClick={checkoutPr}
            onPrMenu={prMenu}
            onRefreshPrs={loadPrs}
            onPruneGone={pruneGone}
            onRefDrop={refDrop}
            worktrees={worktrees}
            submodules={submodules}
            lfs={lfs}
            onOpenRepo={openRepoPath}
            onWorktreeMenu={worktreeMenu}
            onSubmoduleMenu={submoduleMenu}
            onLfsPull={() => run('Pulling LFS files…', () => git('lfsPull', path), 'Downloaded LFS files')}
            onSelectSha={selectSha}
            onRefMenu={refMenu}
            onRefDoubleClick={checkoutRef}
            onStashMenu={stashMenu}
            onRemoteMenu={remoteMenu}
            onAddRemote={addRemote}
            onNewBranch={() => createBranch()}
          />
        </div>
        <Splitter onDrag={(dx) => setSideW((w) => clamp(w + dx, SIDE_MIN, 520))} />
        <div className="center-col">
          <Toolbar
            branch={info?.branch ?? null}
            trail={trail}
            onBack={closeViews}
            busy={busy}
            ahead={track.ahead}
            behind={track.behind}
            canPop={stashes.length > 0}
            undoLabel={history.undo[history.undo.length - 1]?.label ?? null}
            redoLabel={history.redo[history.redo.length - 1]?.label ?? null}
            onUndo={() => applyHistory('undo')}
            onRedo={() => applyHistory('redo')}
            onBranchMenu={branchMenu}
            onPull={() => pull()}
            onPullMenu={pullMenu}
            onPush={() => push()}
            onBranch={() => createBranch()}
            onStash={stash}
            onPop={pop}
            onFetch={fetchAll}
          />
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
              onOpenInEditor={(line) => openInEditor(fileView.path, line)}
            />
          ) : diff && diff.kind === 'wip' && diff.file.status === 'U' ? (
            <ConflictEditor
              key={diff.file.path}
              repo={path}
              file={status.conflicted.find((f) => f.path === diff.file.path) ?? diff.file}
              sides={sides}
              onClose={() => setDiff(null)}
              onResolve={(content, encoding) =>
                run(
                  'Resolving…',
                  async () => {
                    await git('writeConflictFile', path, diff.file.path, content, encoding);
                    await git('stage', path, [diff.file.path]);
                  },
                  `Resolved ${diff.file.path}`
                )
              }
              onTake={(side) => takeSide(diff.file, side)}
              onKeep={() => keepConflictFile(diff.file)}
              onDelete={() => deleteConflictFile(diff.file)}
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
              onHistory={diff.file.status === '?' || diff.file.status === 'A' ? undefined : () => openFileView(diff.file.path, 'history')}
              onBlame={
                diff.file.status === 'D' || diff.file.status === '?' || (diff.kind === 'wip' && diff.file.status === 'A')
                  ? undefined
                  : () => openFileView(diff.file.path, 'blame', diff.kind === 'commit' ? diff.sha : undefined)
              }
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
              onRefDrop={refDrop}
              wipFiles={wipFiles}
              ci={ci}
              canLoadMore={commits.length >= logLimit}
              onLoadMore={() => setLogLimit((n) => n + LOG_PAGE)}
              banner={
                bisect && (
                  <BisectBanner
                    state={bisect}
                    head={info?.head ?? null}
                    subject={(sha) => commits.find((c) => c.sha === sha)?.subject ?? ''}
                    onMark={(v) => markBisect(v)}
                    onShow={(sha) => selectSha(sha)}
                    onStop={stopBisect}
                  />
                )
              }
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
        </div>
        <Splitter onDrag={(dx) => setRightW((w) => clamp(w - dx, RIGHT_MIN, 720))} />
        <div className="right" style={{ width: rightShown }}>
          {openPr ? (
            <PrPanel
              repo={path}
              number={openPr.number}
              version={prsLoaded}
              act={prAct}
              onSelectSha={selectSha}
              onCheckout={() => {
                const pr = prs.find((p) => p.number === openPr.number);
                if (pr) checkoutPr(pr);
              }}
              onClose={closePr}
            />
          ) : info && stagingVisible ? (
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
              activeStaged={diff?.kind === 'wip' ? diff.staged : null}
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
              sides={sides}
              stashConflict={stashConflict}
              onResolve={takeSide}
              onMarkResolved={(f) => run('Staging…', () => git('stage', path, [f.path]))}
              onKeep={keepConflictFile}
              onDelete={deleteConflictFile}
              onAbort={() => info.state && run('Aborting…', () => git('abort', path, info.state), 'Aborted')}
              onContinue={() => info.state && run('Continuing…', () => git('continueOp', path, info.state))}
              onSkip={() => run('Skipping…', () => git('skipRebase', path))}
              behind={track.behind > 0 && currentRef?.upstream ? { count: track.behind, upstream: currentRef.upstream } : null}
              onPull={() => pull()}
              coAuthors={coAuthors}
              onCoAuthorMenu={coAuthorMenu}
              onRemoveCoAuthor={(a) => setCoAuthors((cs) => cs.filter((c) => c.email !== a.email))}
              onEditGitignore={() => setGitignoreOpen(true)}
              onIgnoredMenu={(e, f) =>
                ui.menu(e, [
                  { label: 'Show in folder', onClick: () => api.showItem(joinPath(path, f.replace(/\/$/, ''))) },
                  { label: 'Copy path', onClick: () => copy(f) },
                ])
              }
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
              stash={selectedStash}
              onStashAction={(action) => selectedStash && stashAction(selectedStash, action)}
            />
          ) : (
            <div className="panel-empty">Select a commit to see its details</div>
          )}
        </div>
      </div>
      {gitignoreOpen && <GitignoreDialog repo={path} onClose={() => setGitignoreOpen(false)} onSaved={() => ui.toast('Saved .gitignore', 'success')} />}
      {recoverOpen && (
        <RecoverDialog
          repo={path}
          onClose={() => setRecoverOpen(false)}
          onCreateBranch={(sha) => {
            setRecoverOpen(false);
            createBranch(sha);
          }}
          onShow={(sha) => {
            setRecoverOpen(false);
            selectSha(sha);
          }}
        />
      )}
      {prDraft && (
        <CreatePrDialog
          head={prDraft.head}
          needsPush={prDraft.needsPush}
          defaultBase={prDraft.base}
          defaultTitle={prDraft.title}
          defaultBody=""
          bases={[...new Set([prDraft.base, ...refs.filter((r) => r.type !== 'tag').map(branchName)])].filter((b) => b !== prDraft.head)}
          onCancel={() => setPrDraft(null)}
          onCreate={createPr}
        />
      )}
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
