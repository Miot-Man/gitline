import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Laptop, Cloud, Archive, Tag, Folder, Check, Plus, Search, ArrowUp, ArrowDown } from 'lucide-react';
import type { Ref, Stash } from '../types';
import { parseTrack } from '../lib/format';

interface Props {
  refs: Ref[];
  stashes: Stash[];
  remotes: string[];
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
          <button className="icon-btn" title="Create branch" onClick={props.onNewBranch}>
            <Plus size={13} />
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

function RefRow({ r, depth, icon, onSelectSha, onRefMenu, onRefDoubleClick }: { r: Ref; depth: number; icon: 'local' | 'remote' } & Props) {
  const t = parseTrack(r.track);
  const label = r.name.split('/').pop();
  return (
    <div
      className={`side-item${r.isHead ? ' head' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onClick={() => onSelectSha(r.sha)}
      onDoubleClick={() => onRefDoubleClick(r)}
      onContextMenu={(e) => onRefMenu(e, r)}
      title={r.upstream ? `${r.name} → ${r.upstream}` : r.name}
    >
      {r.isHead ? <Check size={13} className="side-icon head-icon" /> : icon === 'local' ? <Laptop size={13} className="side-icon" /> : <Cloud size={13} className="side-icon" />}
      <span className="side-label">{label}</span>
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
