import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { git } from '../api';
import { hasMarkers, parseConflicts, resolved, type Choice, type Segment } from '../lib/conflicts';

interface Props {
  repo: string;
  path: string;
  onClose: () => void;
  onResolve: (content: string) => void;
  onTake: (side: 'ours' | 'theirs') => void;
}

export function ConflictEditor({ repo, path, onClose, onResolve, onTake }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [output, setOutput] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    let alive = true;
    git<string>('readFile', repo, path)
      .then((c) => {
        if (!alive) return;
        setContent(c);
        setChoices({});
        setEdited(false);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // Re-reading on every repo change would throw away the user's choices; only reload per file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, path]);

  const segs = useMemo(() => (content === null ? [] : parseConflicts(content)), [content]);
  const conflicts = segs.flatMap((s, i) => (s.kind === 'conflict' ? [i] : []));
  const binary = content?.includes('\0');

  // The result follows the choices until the user types into it.
  useEffect(() => {
    if (edited) return;
    setOutput(segs.map((s, i) => (s.kind === 'text' ? s.text : resolved(s, choices[i]))).join(''));
  }, [segs, choices, edited]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (i: number, c: Choice) => {
    setEdited(false);
    setChoices((cur) => ({ ...cur, [i]: c }));
  };
  const chooseAll = (c: Choice) => {
    setEdited(false);
    setChoices(Object.fromEntries(conflicts.map((i) => [i, c])));
  };

  const done = conflicts.filter((i) => choices[i]).length;
  const markersLeft = hasMarkers(output);

  return (
    <div className="conflict-editor">
      <div className="diff-header">
        <AlertTriangle size={14} className="st st-conf" />
        <span className="diff-path">{path}</span>
        <span className="diff-badge unstaged">Conflict</span>
        {!binary && conflicts.length > 0 && (
          <span className="muted">
            {done} of {conflicts.length} resolved
          </span>
        )}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => (binary ? onTake('ours') : chooseAll('ours'))}>
          {binary ? 'Take ours' : 'All ours'}
        </button>
        <button className="btn btn-sm" onClick={() => (binary ? onTake('theirs') : chooseAll('theirs'))}>
          {binary ? 'Take theirs' : 'All theirs'}
        </button>
        {!binary && (
          <button
            className="btn btn-sm btn-stage"
            disabled={content === null || markersLeft}
            title={markersLeft ? 'Resolve every conflict (or remove the markers) first' : 'Save the result and stage the file'}
            onClick={() => onResolve(output)}
          >
            Save & Mark Resolved
          </button>
        )}
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={16} />
        </button>
      </div>
      {error && <div className="diff-message">{error}</div>}
      {binary && <div className="diff-message">This is a binary file. Take one side with the buttons above.</div>}
      {content !== null && !binary && (
        <div className="conflict-body">
          {conflicts.length === 0 && <div className="diff-message">No conflict markers found. Edit the result if needed, then mark it resolved.</div>}
          {conflicts.map((i, n) => {
            const s = segs[i] as Extract<Segment, { kind: 'conflict' }>;
            const c = choices[i];
            return (
              <div key={i} className={`conflict-card${c ? ' done' : ''}`}>
                <div className="conflict-card-header">
                  <span>
                    Conflict {n + 1} of {conflicts.length}
                  </span>
                  <span className="seg">
                    {(
                      [
                        ['ours', 'Ours'],
                        ['theirs', 'Theirs'],
                        ['both', 'Both (ours first)'],
                        ['both-reverse', 'Both (theirs first)'],
                      ] as [Choice, string][]
                    ).map(([k, label]) => (
                      <button key={k} className={c === k ? 'on' : ''} onClick={() => choose(i, k)}>
                        {label}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="conflict-sides">
                  <div className={`conflict-side ours${c === 'theirs' ? ' dropped' : ''}`}>
                    <div className="conflict-label">Ours · {s.oursLabel || 'HEAD'}</div>
                    <pre>{s.ours || ' '}</pre>
                  </div>
                  <div className={`conflict-side theirs${c === 'ours' ? ' dropped' : ''}`}>
                    <div className="conflict-label">Theirs · {s.theirsLabel || 'incoming'}</div>
                    <pre>{s.theirs || ' '}</pre>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="conflict-result">
            <div className="conflict-label">
              Result {edited ? '(edited by hand; choosing a side above resets it)' : '(editable)'}
              {markersLeft && <span className="conflict-left"> · conflict markers remain</span>}
            </div>
            <textarea
              spellCheck={false}
              value={output}
              onChange={(e) => {
                setEdited(true);
                setOutput(e.target.value);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
