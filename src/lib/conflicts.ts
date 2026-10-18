// Parsing and resolving git conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>), and naming the
// two sides of a conflict by what they are rather than git's "ours" / "theirs".
import type { ConflictKind, RepoInfo } from '../types';

export type Choice = 'ours' | 'theirs' | 'both' | 'both-reverse';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'conflict'; ours: string; theirs: string; base: string | null; oursLabel: string; theirsLabel: string };

// A marker line is exactly seven marker characters, then a space (and a label) or the end of the line.
const isMarker = (line: string, ch: '<' | '|' | '=' | '>') => line.startsWith(ch.repeat(7)) && /^(?: |\r?\n?$)/.test(line.slice(7));

// Splits a file into plain text and conflict blocks, keeping line endings. Handles diff3 / zdiff3 base sections.
export function parseConflicts(content: string): Segment[] {
  const lines = content.split(/(?<=\n)/);
  const segs: Segment[] = [];
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    if (!isMarker(lines[i], '<')) {
      text += lines[i];
      continue;
    }
    const oursLabel = lines[i].slice(7).trim();
    let ours = '';
    let base: string | null = null;
    let theirs = '';
    let j = i + 1;
    while (j < lines.length && !isMarker(lines[j], '|') && !isMarker(lines[j], '=')) ours += lines[j++];
    if (j < lines.length && isMarker(lines[j], '|')) {
      base = '';
      j++;
      while (j < lines.length && !isMarker(lines[j], '=')) base += lines[j++];
    }
    j++;
    while (j < lines.length && !isMarker(lines[j], '>')) theirs += lines[j++];
    if (j >= lines.length) {
      // Unterminated marker: treat the rest as plain text.
      text += lines.slice(i).join('');
      break;
    }
    if (text) segs.push({ kind: 'text', text });
    text = '';
    segs.push({ kind: 'conflict', ours, theirs, base, oursLabel, theirsLabel: lines[j].slice(7).trim() });
    i = j;
  }
  if (text) segs.push({ kind: 'text', text });
  return segs;
}

export function resolved(seg: Extract<Segment, { kind: 'conflict' }>, choice: Choice | undefined) {
  switch (choice) {
    case 'ours':
      return seg.ours;
    case 'theirs':
      return seg.theirs;
    case 'both':
      return seg.ours + seg.theirs;
    case 'both-reverse':
      return seg.theirs + seg.ours;
    default:
      return `<<<<<<< ${seg.oursLabel}\n${seg.ours}=======\n${seg.theirs}>>>>>>> ${seg.theirsLabel}\n`;
  }
}

// Whether text still has a conflict in it, or a stray start / end marker. A lone ======= line is
// ordinary text (a Markdown or reStructuredText heading underline, say).
export const hasMarkers = (s: string) => /^(<<<<<<<|>>>>>>>)( |\r?$)/m.test(s) || parseConflicts(s).some((x) => x.kind === 'conflict');

export interface Side {
  label: string; // for buttons and headings: "Your commit"
  noun: string; // inside a sentence: "deleted by your commit"
  title: string; // tooltip naming the branch or commit
}

export interface Sides {
  ours: Side; // git's "ours"
  theirs: Side; // git's "theirs"
}

const short = (c: { sha: string; subject: string } | null) => (c ? `${c.sha.slice(0, 7)} ${c.subject}` : 'unknown commit');

// Names git's "ours" and "theirs" for the operation in progress. During a rebase they are the reverse of
// what the words suggest: "ours" is the branch being rebased onto and "theirs" is the user's own commit.
// `stash` is the stash being applied when a stash apply / pop stopped on conflicts.
export function conflictSides(info: Pick<RepoInfo, 'state' | 'branch' | 'opCommit' | 'onto'> | null, stash: string | null = null): Sides {
  const commit = info?.opCommit ?? null;
  const current: Side = { label: 'Current branch', noun: 'the current branch', title: `Current branch (${info?.branch ?? 'detached HEAD'})` };
  switch (info?.state) {
    case 'merge':
      return { ours: current, theirs: { label: 'Incoming', noun: 'incoming', title: `Incoming (${commit?.name ?? short(commit)})` } };
    case 'rebase':
      return {
        ours: { label: 'Upstream', noun: 'upstream', title: `Upstream (${info.onto?.name ?? short(info.onto)})` },
        theirs: { label: 'Your commit', noun: 'your commit', title: `Your commit (${short(commit)})` },
      };
    case 'cherry-pick':
      return { ours: current, theirs: { label: 'Picked commit', noun: 'the picked commit', title: `Picked commit (${short(commit)})` } };
    case 'revert':
      return {
        ours: current,
        theirs: { label: "Reverted commit's parent", noun: 'the revert', title: `The version before the reverted commit (${short(commit)})` },
      };
  }
  if (stash)
    return {
      ours: { label: 'Current files', noun: 'the current files', title: 'Your files as they were before the stash was applied' },
      theirs: { label: 'Stash', noun: 'the stash', title: `Stash (${stash})` },
    };
  return {
    ours: { label: 'Ours', noun: 'us', title: "git's \"ours\" side" },
    theirs: { label: 'Theirs', noun: 'them', title: "git's \"theirs\" side" },
  };
}

// Conflicts where one or both sides deleted the file (or only one side has it): resolved by keeping
// or deleting the file, not in the marker editor.
export const isDeletion = (kind: ConflictKind | undefined) => !!kind && kind !== 'both-modified' && kind !== 'both-added';

export function kindLabel(kind: ConflictKind | undefined, sides: Sides) {
  switch (kind) {
    case 'both-modified':
      return 'both modified';
    case 'both-added':
      return 'both added';
    case 'deleted-by-us':
      return `deleted by ${sides.ours.noun}`;
    case 'deleted-by-them':
      return `deleted by ${sides.theirs.noun}`;
    case 'added-by-us':
      return `added by ${sides.ours.noun}`;
    case 'added-by-them':
      return `added by ${sides.theirs.noun}`;
    case 'both-deleted':
      return 'deleted by both';
    default:
      return '';
  }
}

// What each side did to a file in a deletion conflict.
export function sideActions(kind: ConflictKind): { ours: string; theirs: string } {
  switch (kind) {
    case 'deleted-by-us':
      return { ours: 'Deleted the file', theirs: 'Changed the file' };
    case 'deleted-by-them':
      return { ours: 'Changed the file', theirs: 'Deleted the file' };
    case 'added-by-us':
      return { ours: 'Added the file (or renamed a file to this name)', theirs: "Doesn't have the file" };
    case 'added-by-them':
      return { ours: "Doesn't have the file", theirs: 'Added the file (or renamed a file to this name)' };
    case 'both-deleted':
      return { ours: 'Deleted (or renamed) the file', theirs: 'Deleted (or renamed) the file' };
    default:
      return { ours: 'Changed the file', theirs: 'Changed the file' };
  }
}

const splitLines = (s: string) => (s ? s.split(/(?<=\n)/) : []);
export const stripEol = (line: string) => line.replace(/\r?\n$/, '');

export interface NumberedLine {
  no: number;
  text: string;
}

// Where a conflict lands in the result: its first line, the result line numbers of each side (null when
// that side isn't in the result), and the unchanged lines just above and below it.
export interface ConflictLayout {
  start: number;
  ours: number | null;
  theirs: number | null;
  before: NumberedLine[];
  after: NumberedLine[];
}

// Line numbers follow the result the choices produce; an undecided conflict keeps its markers there.
export function conflictLayout(segs: Segment[], choices: Record<number, Choice>, context = 3): Record<number, ConflictLayout> {
  const out: Record<number, ConflictLayout> = {};
  const starts: number[] = [];
  let line = 1;
  segs.forEach((s, i) => {
    starts.push(line);
    line += splitLines(s.kind === 'text' ? s.text : resolved(s, choices[i])).length;
  });
  const numbered = (i: number) => {
    const s = segs[i];
    return s?.kind === 'text' ? splitLines(s.text).map((t, k) => ({ no: starts[i] + k, text: stripEol(t) })) : [];
  };
  segs.forEach((s, i) => {
    if (s.kind !== 'conflict') return;
    const start = starts[i];
    const nOurs = splitLines(s.ours).length;
    const nTheirs = splitLines(s.theirs).length;
    const at: Record<string, [number | null, number | null]> = {
      ours: [start, null],
      theirs: [null, start],
      both: [start, start + nOurs],
      'both-reverse': [start + nTheirs, start],
      // <<<<<<< line, ours, =======, theirs, >>>>>>>
      none: [start + 1, start + nOurs + 2],
    };
    const [ours, theirs] = at[choices[i] ?? 'none'];
    out[i] = { start, ours, theirs, before: numbered(i - 1).slice(-context), after: numbered(i + 1).slice(0, context) };
  });
  return out;
}
