import { useEffect, useMemo, useState } from 'react';
import { Columns2, Rows3 } from 'lucide-react';
import type { DiffTarget } from '../types';
import { git } from '../api';
import { buildLinePatch, parseDiff, type DiffLine, type Hunk } from '../lib/diff';
import { StatusIcon } from './RightPanel';
import { IMAGE_EXT, ImageDiff, type ImageSide } from './ImageDiff';
import { LANGUAGES, PLAIN, guessLanguage, highlightLines, isLoaded, languageFor, loadLanguage, markRanges, patternFor } from '../lib/highlight';
import { saveSettings, useSettings } from '../lib/settings';
import { changedRanges, pairWordDiffs } from '../lib/wordDiff';

interface Props {
  repo: string;
  target: DiffTarget;
  version: number;
  onClose: () => void;
  onStageFile: () => void;
  onUnstageFile: () => void;
  onDiscardFile: () => void;
  onApplyHunk: (patch: string, cached: boolean, reverse: boolean) => void;
  onHistory?: () => void;
  onBlame?: () => void;
}

const MAX_LINES = 20000;

export function DiffView({ repo, target, version, onClose, onStageFile, onUnstageFile, onDiscardFile, onApplyHunk, onHistory, onBlame }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(() => localStorage.getItem('diffSplit') === '1');
  const [ignoreWs, setIgnoreWs] = useState(() => localStorage.getItem('diffIgnoreWs') === '1');
  // Selected +/- lines for line-level staging; only one hunk at a time.
  const [sel, setSel] = useState<{ hunk: number; lines: Set<number>; anchor: number } | null>(null);
  const file = target.file;

  useEffect(() => {
    let alive = true;
    setError(null);
    const p =
      target.kind === 'wip'
        ? git<string>('diffWorking', repo, file.path, target.staged, file.status === '?', target.staged ? file.oldPath : undefined, ignoreWs)
        : git<string>('diffCommit', repo, target.sha, file.path, file.oldPath, target.parent, ignoreWs);
    p.then((t) => alive && setText(t)).catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repo, target, version, file, ignoreWs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = useMemo(() => (text === null ? null : parseDiff(text)), [text]);
  useEffect(() => setSel(null), [text]);
  const isWip = target.kind === 'wip';
  const staged = isWip && target.staged;
  const untracked = file.status === '?';
  // A whitespace-blind diff doesn't match the file, so its hunks can't be staged or discarded.
  const hunkActions = isWip && !untracked && file.status !== 'U' && !ignoreWs && parsed && !parsed.combined && !parsed.binary;
  // Language for this file: the user's choice for its type, else Gitline's guess. Loaded on first use.
  const { syntaxHighlighting, syntaxRules } = useSettings();
  const chosen = syntaxHighlighting ? languageFor(file.path, syntaxRules) : null;
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (chosen && !isLoaded(chosen)) loadLanguage(chosen).then(() => setLoaded((n) => n + 1));
  }, [chosen]);
  const lang = chosen && isLoaded(chosen) ? chosen : null;

  // Picking a language remembers it for every file of this type; picking Gitline's own guess forgets the choice.
  const pickLanguage = (id: string) => {
    const pattern = patternFor(file.path);
    const others = syntaxRules.filter((r) => r.pattern.toLowerCase() !== pattern.toLowerCase());
    const guess = guessLanguage(file.path) ?? PLAIN;
    saveSettings({ syntaxRules: id === guess ? others : [...others, { pattern, language: id }] });
  };
  const totalLines = parsed ? parsed.hunks.reduce((n, h) => n + h.lines.length, 0) : 0;
  const added = parsed ? parsed.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0) : 0;
  const removed = parsed ? parsed.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0) : 0;

  // Binary images get a before / after view instead of "no text diff".
  const image = parsed?.binary && IMAGE_EXT.test(file.path) ? imageSides(target) : null;

  // Click toggles a line; shift-click selects every change line between the anchor and here.
  const selectLine = (hunk: number, line: number, shift: boolean) => {
    const lines = parsed!.hunks[hunk].lines;
    if (lines[line].type !== 'add' && lines[line].type !== 'del') return;
    setSel((cur) => {
      if (shift && cur && cur.hunk === hunk) {
        const next = new Set(cur.lines);
        const [a, b] = [Math.min(cur.anchor, line), Math.max(cur.anchor, line)];
        for (let i = a; i <= b; i++) if (lines[i].type === 'add' || lines[i].type === 'del') next.add(i);
        return { ...cur, lines: next };
      }
      const next = new Set(cur && cur.hunk === hunk ? cur.lines : []);
      next.has(line) ? next.delete(line) : next.add(line);
      return next.size ? { hunk, lines: next, anchor: line } : null;
    });
  };

  const applyLines = (h: Hunk, cached: boolean, reverse: boolean) => {
    if (!sel || !parsed) return;
    onApplyHunk(buildLinePatch(parsed.header, h, sel.lines, reverse), cached, reverse);
    setSel(null);
  };

  const toggleIgnoreWs = () => {
    setIgnoreWs((v) => {
      localStorage.setItem('diffIgnoreWs', v ? '0' : '1');
      return !v;
    });
  };

  const toggleSplit = () => {
    setSplit((s) => {
      localStorage.setItem('diffSplit', s ? '0' : '1');
      return !s;
    });
  };

  return (
    <div className="diff-view">
      <div className="diff-header">
        <StatusIcon status={file.status} />
        {file.oldPath && file.oldPath !== file.path && <span className="diff-renamed">renamed from {file.oldPath}</span>}
        {parsed && !parsed.binary && (
          <span className="diff-counts">
            <span className="add">+{added}</span>
            <span className="del">−{removed}</span>
          </span>
        )}
        {isWip && <span className={`diff-badge ${staged ? 'staged' : 'unstaged'}`}>{staged ? 'Staged' : 'Unstaged'}</span>}
        <span className="spacer" />
        {syntaxHighlighting && !parsed?.binary && (
          <select
            className="lang-picker"
            aria-label="Syntax highlighting language"
            title={`Language for ${patternFor(file.path)} files (remembered; change in Settings)`}
            value={chosen ?? PLAIN}
            onChange={(e) => pickLanguage(e.target.value)}
          >
            <option value={PLAIN}>Plain text</option>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.id === guessLanguage(file.path) ? ' (auto)' : ''}
              </option>
            ))}
          </select>
        )}
        <button
          className={`btn btn-sm ws-toggle${ignoreWs ? ' on' : ''}`}
          onClick={toggleIgnoreWs}
          aria-pressed={ignoreWs}
          title={ignoreWs ? 'Showing changes without whitespace-only edits (staging hunks is off)' : 'Hide whitespace-only changes'}
        >
          Ignore whitespace
        </button>
        <div className="seg">
          <button className={!split ? 'on' : ''} onClick={() => split && toggleSplit()} title="Unified">
            <Rows3 size={14} />
          </button>
          <button className={split ? 'on' : ''} onClick={() => !split && toggleSplit()} title="Split">
            <Columns2 size={14} />
          </button>
        </div>
        {onHistory && (
          <button className="btn btn-sm" onClick={onHistory}>
            History
          </button>
        )}
        {onBlame && (
          <button className="btn btn-sm" onClick={onBlame}>
            Blame
          </button>
        )}
        {isWip && !staged && file.status !== 'U' && (
          <button className="btn btn-sm btn-danger-ghost" onClick={onDiscardFile}>
            Discard File
          </button>
        )}
        {isWip && !staged && (
          <button className="btn btn-sm btn-stage" onClick={onStageFile}>
            {file.status === 'U' ? 'Mark Resolved' : 'Stage File'}
          </button>
        )}
        {isWip && staged && (
          <button className="btn btn-sm btn-unstage" onClick={onUnstageFile}>
            Unstage File
          </button>
        )}
      </div>
      <div className="diff-body">
        {error && <div className="diff-message">{error}</div>}
        {!error && parsed === null && <div className="diff-message">Loading…</div>}
        {image && <ImageDiff repo={repo} before={image.before} after={image.after} version={version} />}
        {parsed && parsed.binary && !image && <div className="diff-message">Binary file — no text diff available.</div>}
        {parsed && !parsed.binary && parsed.hunks.length === 0 && (
          <div className="diff-message">{text?.trim() ? <pre>{text}</pre> : 'No changes (file mode change or empty file).'}</div>
        )}
        {parsed && totalLines > MAX_LINES && <div className="diff-message">Diff is very large; showing the first {MAX_LINES.toLocaleString()} lines.</div>}
        {parsed &&
          !parsed.binary &&
          limitHunks(parsed.hunks).map((h, i) => (
            <div className="hunk" key={i}>
              <div className="hunk-header">
                <code>{h.header}</code>
                {hunkActions && sel?.hunk === i ? (
                  <span className="hunk-actions">
                    <button className="btn btn-xs" onClick={() => setSel(null)}>
                      Clear
                    </button>
                    {!staged && (
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => applyLines(h, false, true)}>
                        Discard {sel.lines.size} line{sel.lines.size === 1 ? '' : 's'}
                      </button>
                    )}
                    {!staged ? (
                      <button className="btn btn-xs btn-stage" onClick={() => applyLines(h, true, false)}>
                        Stage {sel.lines.size} line{sel.lines.size === 1 ? '' : 's'}
                      </button>
                    ) : (
                      <button className="btn btn-xs btn-unstage" onClick={() => applyLines(h, true, true)}>
                        Unstage {sel.lines.size} line{sel.lines.size === 1 ? '' : 's'}
                      </button>
                    )}
                  </span>
                ) : hunkActions && (
                  <span className="hunk-actions">
                    {!staged && (
                      <button className="btn btn-xs btn-danger-ghost" onClick={() => onApplyHunk(parsed.header + h.raw, false, true)}>
                        Discard Hunk
                      </button>
                    )}
                    {!staged ? (
                      <button className="btn btn-xs btn-stage" onClick={() => onApplyHunk(parsed.header + h.raw, true, false)}>
                        Stage Hunk
                      </button>
                    ) : (
                      <button className="btn btn-xs btn-unstage" onClick={() => onApplyHunk(parsed.header + h.raw, true, true)}>
                        Unstage Hunk
                      </button>
                    )}
                  </span>
                )}
              </div>
              {split ? (
                <SplitHunk lines={h.lines} lang={lang} />
              ) : (
                <UnifiedHunk
                  lang={lang}
                  lines={h.lines}
                  selected={sel?.hunk === i ? sel.lines : undefined}
                  onSelect={hunkActions ? (line, shift) => selectLine(i, line, shift) : undefined}
                />
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function imageSides(target: DiffTarget): { before: ImageSide | null; after: ImageSide | null } {
  const f = target.file;
  const oldPath = f.oldPath ?? f.path;
  const added = f.status === 'A' || f.status === '?';
  const deleted = f.status === 'D';
  if (target.kind === 'wip') {
    return target.staged
      ? { before: added ? null : { rev: 'HEAD', path: oldPath }, after: deleted ? null : { rev: ':', path: f.path } }
      : { before: added ? null : { rev: ':', path: f.path }, after: deleted ? null : { rev: null, path: f.path } };
  }
  return {
    before: added ? null : { rev: target.parent ?? `${target.sha}^`, path: oldPath },
    after: deleted ? null : { rev: target.sha, path: f.path },
  };
}

function limitHunks(hunks: Hunk[]) {
  let n = 0;
  const out: Hunk[] = [];
  for (const h of hunks) {
    if (n >= MAX_LINES) break;
    out.push(n + h.lines.length > MAX_LINES ? { ...h, lines: h.lines.slice(0, MAX_LINES - n) } : h);
    n += h.lines.length;
  }
  return out;
}

const sign = (t: DiffLine['type']) => (t === 'add' ? '+' : t === 'del' ? '-' : ' ');

// HTML for every line of a hunk. Each side (old: context + removed, new: context + added) is highlighted
// as one text so docstrings and block comments carry across lines; changed words are marked on top.
function useHunkHtml(lines: DiffLine[], lang: string | null): string[] {
  return useMemo(() => {
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    lines.forEach((l, i) => {
      if (l.type === 'ctx' || l.type === 'del') oldIdx.push(i);
      if (l.type === 'ctx' || l.type === 'add') newIdx.push(i);
    });
    const html: string[] = lines.map((l) => (l.type === 'meta' ? l.text : ''));
    const oldHtml = highlightLines(oldIdx.map((i) => lines[i].text), lang);
    const newHtml = highlightLines(newIdx.map((i) => lines[i].text), lang);
    oldIdx.forEach((i, k) => (html[i] = oldHtml[k]));
    newIdx.forEach((i, k) => (html[i] = newHtml[k]));
    for (const [i, segs] of pairWordDiffs(lines)) html[i] = markRanges(html[i], changedRanges(segs));
    return html;
  }, [lines, lang]);
}

// highlight.js and markRanges escape the source text, so this HTML is safe to insert.
const Code = ({ html }: { html: string }) => <span dangerouslySetInnerHTML={{ __html: html }} />;

function UnifiedHunk({
  lines,
  lang,
  selected,
  onSelect,
}: {
  lines: DiffLine[];
  lang: string | null;
  selected?: Set<number>;
  onSelect?: (line: number, shift: boolean) => void;
}) {
  const html = useHunkHtml(lines, lang);
  return (
    <table className="diff-table">
      <tbody>
        {lines.map((l, i) =>
          l.type === 'meta' ? (
            <tr key={i} className="dl-meta">
              <td className="ln" />
              <td className="ln" />
              <td className="code">{l.text}</td>
            </tr>
          ) : (
            <tr
              key={i}
              className={`dl-${l.type}${selected?.has(i) ? ' dl-selected' : ''}${onSelect && l.type !== 'ctx' ? ' selectable' : ''}`}
              title={onSelect && l.type !== 'ctx' ? 'Click to select this line, shift-click for a range' : undefined}
            >
              <td className="ln" onMouseDown={(e) => onSelect && (e.preventDefault(), onSelect(i, e.shiftKey))}>
                {l.oldNo ?? ''}
              </td>
              <td className="ln" onMouseDown={(e) => onSelect && (e.preventDefault(), onSelect(i, e.shiftKey))}>
                {l.newNo ?? ''}
              </td>
              <td className="code">
                <span className="sign">{sign(l.type)}</span>
                <Code html={html[i]} />
              </td>
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

function SplitHunk({ lines, lang }: { lines: DiffLine[]; lang: string | null }) {
  const htmlByIndex = useHunkHtml(lines, lang);
  const html = useMemo(() => new Map(lines.map((l, i) => [l, htmlByIndex[i]])), [lines, htmlByIndex]);
  const rows: [DiffLine | null, DiffLine | null][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx' || l.type === 'meta') {
      rows.push([l, l]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
  }
  const cell = (l: DiffLine | null, side: 'old' | 'new') => {
    if (!l) return [<td key="n" className="ln empty" />, <td key="c" className="code empty" />];
    const cls = l.type === 'meta' ? 'dl-meta' : `dl-${l.type}`;
    return [
      <td key="n" className={`ln ${cls}`}>
        {side === 'old' ? l.oldNo ?? '' : l.newNo ?? ''}
      </td>,
      <td key="c" className={`code ${cls}`}>
        {l.type !== 'meta' && <span className="sign">{sign(l.type)}</span>}
        {l.type === 'meta' ? l.text : <Code html={html.get(l) ?? ''} />}
      </td>,
    ];
  };
  return (
    <table className="diff-table split">
      <tbody>
        {rows.map(([a, b], k) => (
          <tr key={k}>
            {cell(a, 'old')}
            {cell(b, 'new')}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
