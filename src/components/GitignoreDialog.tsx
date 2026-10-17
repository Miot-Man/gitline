import { useEffect, useState } from 'react';
import { git } from '../api';

// Common ignore blocks; picking one appends it unless it's already there.
const TEMPLATES: Record<string, string> = {
  Node: 'node_modules/\nnpm-debug.log*\n.npm/\ndist/\nbuild/\n.env\n',
  Python: '__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.pytest_cache/\n*.egg-info/\n.env\n',
  'C / C++': '*.o\n*.obj\n*.a\n*.so\n*.dll\n*.exe\n*.out\nbuild/\ncmake-build-*/\n',
  Java: '*.class\n*.jar\ntarget/\n.gradle/\nbuild/\n',
  Rust: 'target/\n',
  Go: '*.exe\n*.test\n/bin/\n',
  macOS: '.DS_Store\n._*\n',
  Windows: 'Thumbs.db\nDesktop.ini\n',
  'VS Code': '.vscode/*\n!.vscode/settings.json\n!.vscode/extensions.json\n',
  JetBrains: '.idea/\n*.iml\n',
  Logs: '*.log\nlogs/\n',
};

interface Props {
  repo: string;
  onClose: () => void;
  onSaved: () => void;
}

export function GitignoreDialog({ repo, onClose, onSaved }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    git<string>('readFile', repo, '.gitignore')
      .then(setText)
      .catch(() => setText('')); // no .gitignore yet
  }, [repo]);

  const add = (name: string) => {
    setText((t) => {
      const cur = t ?? '';
      if (cur.includes(`# ${name}\n`)) return cur;
      return `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}# ${name}\n${TEMPLATES[name]}`;
    });
  };

  const save = async () => {
    try {
      await git('writeFile', repo, '.gitignore', text ?? '');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal gitignore-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">.gitignore</div>
        <div className="gitignore-templates">
          {Object.keys(TEMPLATES).map((name) => (
            <button key={name} className="btn btn-xs" onClick={() => add(name)} disabled={text === null}>
              + {name}
            </button>
          ))}
        </div>
        <textarea
          aria-label=".gitignore contents"
          autoFocus
          className="gitignore-text"
          spellCheck={false}
          value={text ?? ''}
          placeholder={text === null ? 'Loading…' : 'One pattern per line, e.g. build/ or *.log'}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <div className="rebase-problem">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={text === null} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
