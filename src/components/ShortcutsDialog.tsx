import { shortcut } from '../lib/settings';

const ALT = /Mac/.test(navigator.platform) ? '⌥' : 'Alt+';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Anywhere',
    items: [
      [shortcut('P'), 'Search and run commands'],
      [shortcut('Z'), 'Undo the last git action (or typing in a text box)'],
      [shortcut('Z', true), 'Redo'],
      [shortcut('F'), 'Find a commit (message, changed code or file)'],
      [shortcut('R'), 'Refresh'],
      [shortcut(','), 'Settings'],
      [shortcut('/'), 'This list'],
    ],
  },
  {
    title: 'Tabs and repositories',
    items: [
      [shortcut('T'), 'New tab'],
      [shortcut('W'), 'Close tab'],
      [shortcut('O'), 'Open a repository'],
      [shortcut('N'), 'Clone a repository'],
      [shortcut('I'), 'Start a new repository'],
    ],
  },
  {
    title: 'History and diffs',
    items: [
      ['↑ / ↓', 'Move through commits, or through files while a diff is open'],
      [`${shortcut('')}click`, 'Compare two commits'],
      ['Esc', 'Close a diff, file history or dialog'],
      ['Click / Shift-click line numbers', 'Select lines to stage, unstage or discard'],
    ],
  },
  {
    title: 'Conflicts',
    items: [[`${ALT}↑ / ${ALT}↓`, 'Previous / next conflict in the conflict editor']],
  },
  {
    title: 'Committing',
    items: [[shortcut('Enter'), 'Commit (from the message box)']],
  },
  {
    title: 'Interactive rebase',
    items: [
      ['P R S F D', 'Pick, reword, squash, fixup, drop'],
      [`${ALT}↑ / ${ALT}↓`, 'Move a commit up or down'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal shortcuts-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">Keyboard shortcuts</div>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([keys, what]) => (
                  <div key={what} className="shortcut-row">
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
