import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

const MAX_RESULTS = 60;

// Subsequence match. Rewards consecutive characters and word starts; returns the matched indices for highlighting.
function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const prev = hits[hits.length - 1];
    if (prev !== undefined && found === prev + 1) score += 5;
    if (found === 0 || /[\s/_\-.:]/.test(t[found - 1])) score += 3;
    score -= Math.min(found - ti, 5) * 0.5;
    hits.push(found);
    ti = found + 1;
  }
  return { score: score - t.length * 0.01, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  );
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return commands.slice(0, MAX_RESULTS).map((c) => ({ c, hits: [] as number[] }));
    const scored: { c: PaletteCommand; hits: number[]; score: number }[] = [];
    for (const c of commands) {
      const m = fuzzy(query, c.label);
      if (m) scored.push({ c, ...m });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) setIndex((i) => Math.min(i + 1, results.length - 1));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) setIndex((i) => Math.max(i - 1, 0));
    else if (e.key === 'Enter') choose(results[index]?.c);
    else return;
    e.preventDefault();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Search size={15} />
          <input autoFocus value={query} placeholder="Type a command, branch or repository…" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length ? (
            results.map(({ c, hits }, i) => (
              <button
                key={c.id}
                className={`palette-item${i === index ? ' active' : ''}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => choose(c)}
              >
                {c.group && <span className="palette-group">{c.group}</span>}
                <span className="palette-label">
                  <Highlight text={c.label} hits={hits} />
                </span>
                {c.hint && <span className="menu-hint">{c.hint}</span>}
              </button>
            ))
          ) : (
            <div className="palette-empty">No matching commands</div>
          )}
        </div>
      </div>
    </div>
  );
}
