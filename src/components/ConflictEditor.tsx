import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { git } from '../api';
import type { ConflictFile, FileChange, FileEncoding } from '../types';
import {
  conflictLayout,
  hasMarkers,
  isDeletion,
  kindLabel,
  parseConflicts,
  resolved,
  sideActions,
  stripEol,
  type Choice,
  type NumberedLine,
  type Segment,
  type Sides,
} from '../lib/conflicts';
import { highlightLines, isLoaded, languageFor, loadLanguage, markRanges } from '../lib/highlight';
import { useSettings } from '../lib/settings';
import { changedRanges, wordDiff } from '../lib/wordDiff';

interface Props {
  repo: string;
  file: FileChange;
  sides: Sides;
  onClose: () => void;
  onResolve: (content: string, encoding: FileEncoding) => void;
  onTake: (side: 'ours' | 'theirs') => void;
  onKeep: () => void;
  onDelete: () => void;
}

const ENCODING_LABEL: Record<FileEncoding, string> = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 with BOM', latin1: 'Latin-1' };

// Characters a Latin-1 file can't hold (anything past U+00FF).
const notLatin1 = (s: string) => [...new Set([...s].filter((c) => c.codePointAt(0)! > 0xff))];

const ALT = /Mac/.test(navigator.platform) ? '⌥' : 'Alt+';
const RESULT_LINE_H = 18; // matches .conflict-result textarea's line-height

const lineList = (s: string) => (s ? s.split(/(?<=\n)/).map(stripEol) : []);

// Lines of code with result line numbers (none when `start` is null). `html` comes from highlight.js and
// markRanges, which escape the source text, so it is safe to insert.
function CodeLines({ html, start, className }: { html: string[]; start: number | null; className: string }) {
  return (
    <div className={`conflict-code ${className}`}>
      {html.map((h, i) => (
        <div key={i} className="cl">
          <span className="cl-no">{start === null ? '' : start + i}</span>
          <span className="cl-text" dangerouslySetInnerHTML={{ __html: h || ' ' }} />
        </div>
      ))}
    </div>
  );
}

function Context({ lines, lang, where }: { lines: NumberedLine[]; lang: string | null; where: 'before' | 'after' }) {
  const html = useMemo(() => highlightLines(lines.map((l) => l.text), lang), [lines, lang]);
  if (!lines.length) return null;
  return <CodeLines html={html} start={lines[0].no} className={`context ${where}`} />;
}

export function ConflictEditor({ repo, file, sides, onClose, onResolve, onTake, onKeep, onDelete }: Props) {
  const path = file.path;
  const [content, setContent] = useState<ConflictFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [output, setOutput] = useState('');
  const [edited, setEdited] = useState(false);
  const [baseHidden, setBaseHidden] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const scrollResultTo = useRef<number | null>(null);
  const deletion = isDeletion(file.conflict);

  // Same language rules and on/off setting as the diff view.
  const { syntaxHighlighting, syntaxRules } = useSettings();
  const chosen = syntaxHighlighting ? languageFor(path, syntaxRules) : null;
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (chosen && !isLoaded(chosen)) loadLanguage(chosen).then(() => setLoaded((n) => n + 1));
  }, [chosen]);
  const lang = chosen && isLoaded(chosen) ? chosen : null;

  useEffect(() => {
    let alive = true;
    git<ConflictFile>('readConflictFile', repo, path)
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

  const text = content?.text ?? null;
  const segs = useMemo(() => (text === null || deletion ? [] : parseConflicts(text)), [text, deletion]);
  const conflicts = segs.flatMap((s, i) => (s.kind === 'conflict' ? [i] : []));
  const binary = text?.includes('\0');
  const layout = useMemo(() => conflictLayout(segs, choices), [segs, choices]);

  // Each side highlighted as a whole, with the words that differ between the two sides marked.
  const sideHtml = useMemo(
    () =>
      Object.fromEntries(
        segs.flatMap((s, i) => {
          if (s.kind !== 'conflict') return [];
          const ours = lineList(s.ours);
          const theirs = lineList(s.theirs);
          const oursHtml = highlightLines(ours, lang);
          const theirsHtml = highlightLines(theirs, lang);
          for (let k = 0; k < Math.min(ours.length, theirs.length); k++) {
            const d = ours[k] !== theirs[k] && wordDiff(ours[k], theirs[k]);
            if (!d) continue;
            oursHtml[k] = markRanges(oursHtml[k], changedRanges(d[0]));
            theirsHtml[k] = markRanges(theirsHtml[k], changedRanges(d[1]));
          }
          return [[i, { ours: oursHtml, theirs: theirsHtml, base: s.base === null ? null : highlightLines(lineList(s.base), lang) }]];
        })
      ) as Record<number, { ours: string[]; theirs: string[]; base: string[] | null }>,
    [segs, lang]
  );

  // The result follows the choices until the user types into it.
  useEffect(() => {
    if (edited) return;
    setOutput(segs.map((s, i) => (s.kind === 'text' ? s.text : resolved(s, choices[i]))).join(''));
  }, [segs, choices, edited]);

  // After a choice, show the matching place in the result.
  useEffect(() => {
    const line = scrollResultTo.current;
    if (line === null || !resultRef.current) return;
    scrollResultTo.current = null;
    resultRef.current.scrollTop = Math.max(0, (line - 3) * RESULT_LINE_H);
  }, [output]);

  const goTo = (n: number) => {
    if (!conflicts.length) return;
    const next = Math.max(0, Math.min(conflicts.length - 1, n));
    setCurrent(next);
    cardRefs.current[next]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const stepRef = useRef((d: number) => goTo(current + d));
  stepRef.current = (d: number) => goTo(current + d);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape' && !typing) onClose();
      // Alt+↑ / Alt+↓: previous / next conflict.
      if (e.altKey && !typing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        stepRef.current(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (i: number, c: Choice) => {
    setEdited(false);
    setCurrent(conflicts.indexOf(i));
    scrollResultTo.current = conflictLayout(segs, { ...choices, [i]: c })[i].start;
    setChoices((cur) => ({ ...cur, [i]: c }));
  };
  const chooseAll = (c: Choice) => {
    setEdited(false);
    setChoices(Object.fromEntries(conflicts.map((i) => [i, c])));
  };
  const toggleBase = (i: number) =>
    setBaseHidden((cur) => {
      const next = new Set(cur);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  const done = conflicts.filter((i) => choices[i]).length;
  const markersLeft = hasMarkers(output);
  const unsavable = content?.encoding === 'latin1' ? notLatin1(output) : [];
  const encoding = content && content.encoding !== 'utf-8' && (
    <span className="diff-badge encoding" title={`Saved back as ${ENCODING_LABEL[content.encoding]}`}>
      {ENCODING_LABEL[content.encoding]}
    </span>
  );

  if (deletion) {
    const acts = sideActions(file.conflict!);
    return (
      <div className="conflict-editor">
        <div className="diff-header">
          <AlertTriangle size={14} className="st st-conf" />
          <span className="diff-path">{path}</span>
          <span className="diff-badge unstaged">Conflict</span>
          <span className="muted">{kindLabel(file.conflict, sides)}</span>
          <span className="spacer" />
          {file.conflict !== 'both-deleted' && (
            <button className="btn btn-sm btn-stage" title="Keep the file as it is in the working tree and mark it resolved" onClick={onKeep}>
              Keep file
            </button>
          )}
          <button className="btn btn-sm btn-danger" title="Delete the file and mark it resolved" onClick={onDelete}>
            Delete file
          </button>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        {error && <div className="diff-message">{error}</div>}
        <div className="conflict-body">
          <div className="conflict-card">
            <div className="conflict-sides">
              <div className="conflict-side ours">
                <div className="conflict-label" title={sides.ours.title}>
                  {sides.ours.label}
                </div>
                <div className="conflict-did">{acts.ours}</div>
              </div>
              <div className="conflict-side theirs">
                <div className="conflict-label" title={sides.theirs.title}>
                  {sides.theirs.label}
                </div>
                <div className="conflict-did">{acts.theirs}</div>
              </div>
            </div>
          </div>
          {content && (
            <div className="conflict-result">
              <div className="conflict-label">
                {text === null ? 'Neither side left a copy of this file' : 'The file as it is now (read-only)'} {encoding}
              </div>
              {text !== null && (binary ? <div className="diff-message">Binary file</div> : <pre className="conflict-surviving">{text || ' '}</pre>)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-editor">
      <div className="diff-header">
        <AlertTriangle size={14} className="st st-conf" />
        <span className="diff-path">{path}</span>
        <span className="diff-badge unstaged">Conflict</span>
        {encoding}
        {!binary && conflicts.length > 0 && (
          <span className="muted">
            {done} of {conflicts.length} resolved
          </span>
        )}
        {!binary && conflicts.length > 1 && (
          <span className="conflict-nav">
            <button className="icon-btn" title={`Previous conflict (${ALT}↑)`} aria-label="Previous conflict" disabled={current === 0} onClick={() => goTo(current - 1)}>
              <ChevronUp size={15} />
            </button>
            <button
              className="icon-btn"
              title={`Next conflict (${ALT}↓)`}
              aria-label="Next conflict"
              disabled={current === conflicts.length - 1}
              onClick={() => goTo(current + 1)}
            >
              <ChevronDown size={15} />
            </button>
          </span>
        )}
        <span className="spacer" />
        <span className="muted">{binary ? 'Take' : 'Take all'}</span>
        {(['ours', 'theirs'] as const).map((side) => (
          <button
            key={side}
            className="btn btn-sm"
            title={binary ? `Use ${sides[side].title} for the whole file` : `Use ${sides[side].title} for every conflict`}
            onClick={() => (binary ? onTake(side) : chooseAll(side))}
          >
            {sides[side].label}
          </button>
        ))}
        {!binary && (
          <button
            className="btn btn-sm btn-stage"
            disabled={content === null || markersLeft || unsavable.length > 0}
            title={
              markersLeft
                ? 'Resolve every conflict (or remove the markers) first'
                : unsavable.length
                  ? `This file is Latin-1, which can't hold ${unsavable.slice(0, 5).join(' ')}`
                  : 'Save the result and stage the file'
            }
            onClick={() => content && onResolve(output, content.encoding)}
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
      {text !== null && !binary && (
        <div className="conflict-body">
          {conflicts.length === 0 && <div className="diff-message">No conflict markers found. Edit the result if needed, then mark it resolved.</div>}
          {conflicts.map((i, n) => {
            const s = segs[i] as Extract<Segment, { kind: 'conflict' }>;
            const c = choices[i];
            const at = layout[i];
            const html = sideHtml[i];
            return (
              <div
                key={i}
                ref={(el) => {
                  cardRefs.current[n] = el;
                }}
                className={`conflict-card${c ? ' done' : ''}${n === current && conflicts.length > 1 ? ' current' : ''}`}
                onClick={() => setCurrent(n)}
              >
                <div className="conflict-card-header">
                  <span>
                    Conflict {n + 1} of {conflicts.length}
                  </span>
                  <span className="seg">
                    {(
                      [
                        ['ours', sides.ours.label, sides.ours.title],
                        ['theirs', sides.theirs.label, sides.theirs.title],
                        ['both', `Both (${sides.ours.label} first)`, ''],
                        ['both-reverse', `Both (${sides.theirs.label} first)`, ''],
                      ] as [Choice, string, string][]
                    ).map(([k, label, title]) => (
                      <button key={k} className={c === k ? 'on' : ''} title={title || undefined} onClick={() => choose(i, k)}>
                        {label}
                      </button>
                    ))}
                  </span>
                </div>
                <Context lines={at.before} lang={lang} where="before" />
                {html.base && (
                  <div className="conflict-base">
                    <div className="conflict-label clickable" title="The version both sides started from" onClick={() => toggleBase(i)}>
                      {baseHidden.has(i) ? <ChevronRight size={12} /> : <ChevronDown size={12} />} Original
                    </div>
                    {!baseHidden.has(i) && <CodeLines html={html.base.length ? html.base : ['']} start={null} className="base" />}
                  </div>
                )}
                <div className="conflict-sides">
                  <div className={`conflict-side ours${c === 'theirs' ? ' dropped' : ''}`}>
                    <div className="conflict-label" title={sides.ours.title}>
                      {sides.ours.label}
                    </div>
                    <CodeLines html={html.ours.length ? html.ours : ['']} start={html.ours.length ? at.ours : null} className="ours" />
                  </div>
                  <div className={`conflict-side theirs${c === 'ours' ? ' dropped' : ''}`}>
                    <div className="conflict-label" title={sides.theirs.title}>
                      {sides.theirs.label}
                    </div>
                    <CodeLines html={html.theirs.length ? html.theirs : ['']} start={html.theirs.length ? at.theirs : null} className="theirs" />
                  </div>
                </div>
                <Context lines={at.after} lang={lang} where="after" />
              </div>
            );
          })}
          <div className="conflict-result">
            <div className="conflict-label">
              Result {edited ? '(edited by hand; choosing a side above resets it)' : '(editable)'}
              {markersLeft && <span className="conflict-left"> · conflict markers remain</span>}
              {unsavable.length > 0 && <span className="conflict-left"> · Latin-1 can't hold {unsavable.slice(0, 5).join(' ')}</span>}
            </div>
            <textarea
              ref={resultRef}
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
