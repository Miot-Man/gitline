import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Laptop, Cloud, Archive, Tag, Folder, Check, Plus, Search, ArrowUp, ArrowDown, EyeOff, Crosshair, CloudOff, GitPullRequest, GitPullRequestDraft, Eraser, RefreshCw, FolderTree, Package, HardDrive, AlertTriangle } from 'lucide-react';
import type { GhStatus, GraphFilter, LfsInfo, PullRequest, Ref, Stash, Submodule, Worktree } from '../types';
import { parseTrack } from '../lib/format';

interface Props {
  refs: Ref[];
  stashes: Stash[];
  remotes: string[];
  filter: GraphFilter;
  prs: PullRequest[];
  gh: GhStatus | null;
  onPrClick: (pr: PullRequest) => void;
  onPrDoubleClick: (pr: PullRequest) => void;
  onPrMenu: (e: React.MouseEvent, pr: PullRequest) => void;
  onRefreshPrs: () => void;
  onPruneGone: () => void;
  onRefDrop: (e: React.DragEvent, sourceFull: string, target: Ref) => void;
  worktrees: Worktree[];
  submodules: Submodule[];
  lfs: LfsInfo | null;
  onOpenRepo: (path: string) => void;
  onWorktreeMenu: (e: React.MouseEvent, w: Worktree) => void;
  onSubmoduleMenu: (e: React.MouseEvent, s: Submodule) => void;
  onLfsPull: () => void;
  onSelectSha: (sha: string) => void;
  onRefMenu: (e: React.MouseEvent, r: Ref) => void;
  onRefDoubleClick: (r: Ref) => void;
  onStashMenu: (e: React.MouseEvent, s: Stash) => void;
  onRemoteMenu: (e: React.MouseEvent, remote: string) => void;
  onAddRemote: () => void;
  onNewBranch: () => void;
}

interface TreeNode {
  name: string;
  path: string;
  ref?: Ref;
  children: Map<string, TreeNode>;
}

function buildTree(refs: Ref[], strip = 0): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const r of refs) {
    const parts = r.name.split('/').slice(strip);
    let node = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part + (i === parts.length - 1 ? '' : '/'));
      if (!child) {
        child = { name: part, path: p, children: new Map() };
        node.children.set(part + (i === parts.length - 1 ? '' : '/'), child);
      }
      if (i === parts.length - 1) child.ref = r;
      node = child;
    });
  }
  return root;
}

function sortedChildren(n: TreeNode) {
  return [...n.children.values()].sort((a, b) => {
    const af = a.ref ? 1 : 0;
    const bf = b.ref ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
}

export function Sidebar(props: Props) {
  const { refs, stashes, remotes } = props;
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const f = filter.trim().toLowerCase();

  const toggle = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const match = (r: Ref) => !f || r.name.toLowerCase().includes(f);
  const locals = useMemo(() => refs.filter((r) => r.type === 'local'), [refs]);
  const remoteRefs = useMemo(() => refs.filter((r) => r.type === 'remote'), [refs]);
  const tags = useMemo(() => refs.filter((r) => r.type === 'tag'), [refs]);
  const filteredStashes = stashes.filter((s) => !f || s.message.toLowerCase().includes(f));
  const goneCount = locals.filter((r) => r.track === 'gone' && !r.isHead).length;
  const prs = props.prs.filter((p) => !f || p.title.toLowerCase().includes(f) || p.head.toLowerCase().includes(f) || String(p.number).includes(f));

  const renderTree = (node: TreeNode, depth: number, keyPrefix: string, icon: 'local' | 'remote'): React.ReactNode =>
    sortedChildren(node).map((child) => {
      const key = `${keyPrefix}/${child.path}`;
      if (child.ref && child.children.size === 0) return <RefRow key={key} r={child.ref} depth={depth} icon={icon} {...props} />;
      const open = !collapsed.has(key) || !!f;
      return (
        <div key={key}>
          <div className="side-item folder" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(key)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Folder size={13} className="side-icon" />
            <span className="side-label">{child.name}</span>
          </div>
          {open && renderTree(child, depth + 1, keyPrefix, icon)}
          {child.ref && <RefRow r={child.ref} depth={depth + 1} icon={icon} {...props} />}
        </div>
      );
    });

  const section = (key: string, title: string, count: number, body: React.ReactNode, action?: React.ReactNode) => {
    const open = !collapsed.has(key);
    return (
      <div className="side-section">
        <div className="side-header" onClick={() => toggle(key)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{title}</span>
          <span className="side-count">{count}</span>
          <span className="side-header-actions" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        </div>
        {open && <div className="side-body">{body}</div>}
      </div>
    );
  };

  return (
    <div className="sidebar">
      <div className="side-filter">
        <Search size={13} />
        <input placeholder="Filter (branches, tags, stashes)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="side-scroll">
        {section(
          'local',
          'LOCAL',
          locals.length,
          renderTree(buildTree(locals.filter(match)), 0, 'local', 'local'),
          <>
            {goneCount > 0 && (
              <button className="icon-btn" title={`Delete ${goneCount} branch${goneCount === 1 ? '' : 'es'} whose remote branch is gone`} onClick={props.onPruneGone}>
                <Eraser size={13} />
              </button>
            )}
            <button className="icon-btn" title="Create branch" onClick={props.onNewBranch}>
              <Plus size={13} />
            </button>
          </>
        )}
        {props.gh &&
          props.gh.reason !== 'No GitHub remote' &&
          section(
            'prs',
            'PULL REQUESTS',
            props.prs.length,
            props.gh.ok ? (
              prs.length ? (
                prs.map((pr) => (
                  <div
                    key={pr.number}
                    className="side-item pr-item"
                    style={{ paddingLeft: 24 }}
                    onClick={() => props.onPrClick(pr)}
                    onDoubleClick={() => props.onPrDoubleClick(pr)}
                    onContextMenu={(e) => props.onPrMenu(e, pr)}
                    title={`#${pr.number} ${pr.title}\n${pr.head} → ${pr.base} · by ${pr.author}${pr.draft ? ' · draft' : ''}`}
                  >
                    {pr.draft ? <GitPullRequestDraft size={13} className="side-icon" /> : <GitPullRequest size={13} className="side-icon pr-open" />}
                    <span className="side-label">
                      <span className="pr-num">#{pr.number}</span> {pr.title}
                    </span>
                    {pr.checks && <span className={`pr-checks ${pr.checks}`} title={`Checks: ${pr.checks}`} />}
                  </div>
                ))
              ) : (
                <div className="side-note">No open pull requests</div>
              )
            ) : (
              <div className="side-note">{props.gh.reason}</div>
            ),
            <button className="icon-btn" title="Refresh pull requests" onClick={props.onRefreshPrs}>
              <RefreshCw size={12} />
            </button>
          )}
        {section(
          'remote',
          'REMOTE',
          remotes.length,
          remotes.map((remote) => {
            const key = `remote:${remote}`;
            const open = !collapsed.has(key) || !!f;
            const mine = remoteRefs.filter((r) => r.remote === remote && match(r));
            return (
              <div key={remote}>
                <div
                  className="side-item folder"
                  style={{ paddingLeft: 10 }}
                  onClick={() => toggle(key)}
                  onContextMenu={(e) => props.onRemoteMenu(e, remote)}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Cloud size={13} className="side-icon" />
                  <span className="side-label">{remote}</span>
                </div>
                {open && renderTree(buildTree(mine, 1), 1, key, 'remote')}
              </div>
            );
          }),
          <button className="icon-btn" title="Add remote" onClick={props.onAddRemote}>
            <Plus size={13} />
          </button>
        )}
        {section(
          'stashes',
          'STASHES',
          stashes.length,
          filteredStashes.map((s) => (
            <div
              key={s.ref}
              className="side-item"
              style={{ paddingLeft: 24 }}
              onClick={() => props.onSelectSha(s.sha)}
              onContextMenu={(e) => props.onStashMenu(e, s)}
              title={`${s.ref}: ${s.message}`}
            >
              <Archive size={13} className="side-icon" />
              <span className="side-label">{s.message}</span>
            </div>
          ))
        )}
        {props.worktrees.length > 1 &&
          section(
            'worktrees',
            'WORKTREES',
            props.worktrees.length,
            props.worktrees.map((w) => (
              <div
                key={w.path}
                className={`side-item${w.current ? ' head' : ''}`}
                style={{ paddingLeft: 24 }}
                onDoubleClick={() => !w.current && props.onOpenRepo(w.path)}
                onContextMenu={(e) => props.onWorktreeMenu(e, w)}
                title={`${w.path}${w.prunable ? '\nFolder is missing; prune to clean up' : ''}`}
              >
                {w.current ? <Check size={13} className="side-icon head-icon" /> : <FolderTree size={13} className="side-icon" />}
                <span className="side-label">{w.branch ?? (w.bare ? '(bare)' : `detached ${w.head?.slice(0, 7) ?? ''}`)}</span>
                <span className="side-hint">{w.path.split(/[\\/]/).pop()}</span>
                {w.prunable && <AlertTriangle size={12} className="ref-flag gone" />}
              </div>
            ))
          )}
        {props.submodules.length > 0 &&
          section(
            'submodules',
            'SUBMODULES',
            props.submodules.length,
            props.submodules.map((s) => (
              <div
                key={s.path}
                className={`side-item${s.state === 'uninitialized' ? ' ref-hidden' : ''}`}
                style={{ paddingLeft: 24 }}
                onDoubleClick={() => s.state !== 'uninitialized' && props.onOpenRepo(s.path)}
                onContextMenu={(e) => props.onSubmoduleMenu(e, s)}
                title={`${s.path} @ ${s.sha.slice(0, 7)}${s.describe ? ` (${s.describe})` : ''}\n${SUBMODULE_STATE[s.state]}`}
              >
                <Package size={13} className="side-icon" />
                <span className="side-label">{s.path}</span>
                {s.state !== 'ok' && <span className={`sub-state ${s.state}`}>{s.state === 'uninitialized' ? 'not cloned' : s.state}</span>}
              </div>
            ))
          )}
        {props.lfs?.used &&
          section(
            'lfs',
            'GIT LFS',
            props.lfs.files,
            props.lfs.installed ? (
              <div className="side-item" style={{ paddingLeft: 24 }} onClick={props.onLfsPull} title="Download the large files for this checkout">
                <HardDrive size={13} className="side-icon" />
                <span className="side-label">
                  {props.lfs.files} file{props.lfs.files === 1 ? '' : 's'} in LFS · Pull
                </span>
              </div>
            ) : (
              <div className="side-note">This repo uses Git LFS, but git-lfs isn't installed. Large files will show as small pointer files.</div>
            )
          )}
        {section(
          'tags',
          'TAGS',
          tags.length,
          tags.filter(match).map((t) => (
            <div
              key={t.full}
              className="side-item"
              style={{ paddingLeft: 24 }}
              onClick={() => props.onSelectSha(t.sha)}
              onDoubleClick={() => props.onRefDoubleClick(t)}
              onContextMenu={(e) => props.onRefMenu(e, t)}
            >
              <Tag size={13} className="side-icon" />
              <span className="side-label">{t.name}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const SUBMODULE_STATE: Record<Submodule['state'], string> = {
  ok: 'Checked out at the recorded commit',
  uninitialized: 'Not cloned yet. Right-click to initialize.',
  modified: 'Checked out at a different commit than the one recorded',
  conflict: 'Has a merge conflict',
};

// Drag a branch onto another branch to merge, rebase or open a pull request.
export const REF_DRAG_TYPE = 'application/x-gitline-ref';

export function refDragProps(r: Ref, onDrop: (e: React.DragEvent, sourceFull: string, target: Ref) => void) {
  if (r.type === 'tag') return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(REF_DRAG_TYPE, r.full);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(REF_DRAG_TYPE)) return;
      e.preventDefault();
      e.currentTarget.classList.add('drop-target');
    },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop-target'),
    onDrop: (e: React.DragEvent) => {
      e.currentTarget.classList.remove('drop-target');
      const src = e.dataTransfer.getData(REF_DRAG_TYPE);
      if (src && src !== r.full) {
        e.preventDefault();
        onDrop(e, src, r);
      }
    },
  };
}

function RefRow({ r, depth, icon, filter, prs, onSelectSha, onRefMenu, onRefDoubleClick, onRefDrop }: { r: Ref; depth: number; icon: 'local' | 'remote' } & Props) {
  const t = parseTrack(r.track);
  const branch = r.type === 'remote' ? r.name.split('/').slice(1).join('/') : r.name;
  const pr = prs.find((p) => !p.fork && p.head === branch);
  const label = r.name.split('/').pop();
  const isSolo = filter.solo.includes(r.full);
  const isHidden = filter.hidden.includes(r.full) || (filter.solo.length > 0 && !isSolo && !r.isHead);
  return (
    <div
      className={`side-item${r.isHead ? ' head' : ''}${isHidden ? ' ref-hidden' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onClick={() => onSelectSha(r.sha)}
      onDoubleClick={() => onRefDoubleClick(r)}
      onContextMenu={(e) => onRefMenu(e, r)}
      title={t.gone ? `${r.name}: its remote branch ${r.upstream} was deleted` : r.upstream ? `${r.name} → ${r.upstream}` : r.name}
      {...refDragProps(r, onRefDrop)}
    >
      {r.isHead ? <Check size={13} className="side-icon head-icon" /> : icon === 'local' ? <Laptop size={13} className="side-icon" /> : <Cloud size={13} className="side-icon" />}
      <span className="side-label">{label}</span>
      {pr && (
        <span className="pr-badge" title={`#${pr.number} ${pr.title}`}>
          #{pr.number}
        </span>
      )}
      {t.gone && <CloudOff size={12} className="ref-flag gone" />}
      {isSolo && <Crosshair size={12} className="ref-flag solo" />}
      {filter.hidden.includes(r.full) && <EyeOff size={12} className="ref-flag" />}
      {(t.ahead > 0 || t.behind > 0) && (
        <span className="track">
          {t.behind > 0 && (
            <span>
              {t.behind}
              <ArrowDown size={10} />
            </span>
          )}
          {t.ahead > 0 && (
            <span>
              {t.ahead}
              <ArrowUp size={10} />
            </span>
          )}
        </span>
      )}
    </div>
  );
}
