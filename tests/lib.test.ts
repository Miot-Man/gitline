import { describe, expect, it } from 'vitest';
import { buildLinePatch, parseDiff } from '../src/lib/diff';
import { computeGraph } from '../src/lib/graph';
import { conflictLayout, conflictSides, hasMarkers, kindLabel, parseConflicts, resolved } from '../src/lib/conflicts';
import { cleanTemplate } from '../src/lib/settings';
import { branchCreated, checkoutMove, headMove, refsDeleted, sameHead } from '../src/lib/undo';
import { ignoreLiteral, parseTrack } from '../src/lib/format';

const DIFF = `diff --git a/f b/f
index 1111111..2222222 100644
--- a/f
+++ b/f
@@ -1,3 +1,3 @@ fn
 a
-b
+B
 c
`;

describe('parseDiff', () => {
  it('numbers lines on both sides', () => {
    const d = parseDiff(DIFF);
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['ctx', 3, 3],
    ]);
  });

  it('detects binary files', () => {
    expect(parseDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n').binary).toBe(true);
  });
});

describe('buildLinePatch', () => {
  const hunk = parseDiff(DIFF).hunks[0];
  it('keeps unselected deletions as context when staging', () => {
    const patch = buildLinePatch('H\n', hunk, new Set([2]), false); // only "+B"
    expect(patch).toBe('H\n@@ -1 +1 @@ fn\n a\n b\n+B\n c\n');
  });
  it('keeps unselected additions as context when reversing', () => {
    const patch = buildLinePatch('H\n', hunk, new Set([1]), true); // only "-b"
    // Kept additions come first, so the restored line lands after them.
    expect(patch).toBe('H\n@@ -1 +1 @@ fn\n a\n B\n-b\n c\n');
  });
});

describe('computeGraph', () => {
  it('puts a branch on its own lane and merges it back', () => {
    // m merges f into b; both descend from a.
    const commits = [
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'f', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ];
    const { rows, maxLanes } = computeGraph(commits);
    expect(maxLanes).toBe(2);
    expect(rows[0].parentCols).toEqual([0, 1]);
    expect(rows[1].col).toBe(1);
    expect(rows[3].col).toBe(0);
  });
});

describe('conflicts', () => {
  const text = 'top\n<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> feature\nbottom\n';
  it('parses diff3 blocks', () => {
    const segs = parseConflicts(text);
    expect(segs).toHaveLength(3);
    expect(segs[1]).toMatchObject({ kind: 'conflict', ours: 'ours\n', base: 'base\n', theirs: 'theirs\n', oursLabel: 'HEAD', theirsLabel: 'feature' });
  });
  it('resolves each choice', () => {
    const c = parseConflicts(text)[1];
    if (c.kind !== 'conflict') throw new Error('expected conflict');
    expect(resolved(c, 'ours')).toBe('ours\n');
    expect(resolved(c, 'both-reverse')).toBe('theirs\nours\n');
    expect(hasMarkers(resolved(c, undefined))).toBe(true);
    expect(hasMarkers(resolved(c, 'both'))).toBe(false);
  });
  it('treats an unterminated marker as text', () => {
    expect(parseConflicts('a\n<<<<<<< HEAD\nb\n')).toEqual([{ kind: 'text', text: 'a\n<<<<<<< HEAD\nb\n' }]);
  });
  it('parses zdiff3 output, where shared lines sit outside the block and the base can be empty', () => {
    const z = 'a\nshared\n<<<<<<< HEAD\nY\n||||||| cf87fdb\nb\n=======\nX\n>>>>>>> x\nc\n<<<<<<< HEAD\nadded here\n||||||| cf87fdb\n=======\nadded there\n>>>>>>> x\n';
    const segs = parseConflicts(z);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'conflict', 'text', 'conflict']);
    expect(segs[0]).toEqual({ kind: 'text', text: 'a\nshared\n' });
    expect(segs[1]).toMatchObject({ ours: 'Y\n', base: 'b\n', theirs: 'X\n' });
    expect(segs[3]).toMatchObject({ ours: 'added here\n', base: '', theirs: 'added there\n' });
  });
  it('keeps a line of exactly ======= outside a conflict as text', () => {
    const md = 'Title\n=======\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x\nmore\n========\n';
    const segs = parseConflicts(md);
    expect(segs).toEqual([
      { kind: 'text', text: 'Title\n=======\n\n' },
      { kind: 'conflict', ours: 'ours\n', theirs: 'theirs\n', base: null, oursLabel: 'HEAD', theirsLabel: 'x' },
      { kind: 'text', text: 'more\n========\n' },
    ]);
    const c = segs[1] as Extract<(typeof segs)[number], { kind: 'conflict' }>;
    const result = 'Title\n=======\n\n' + resolved(c, 'theirs') + 'more\n========\n';
    expect(hasMarkers(result)).toBe(false);
    expect(hasMarkers(result + '>>>>>>> x\n')).toBe(true);
  });
  it('reads markers with Windows line endings', () => {
    const segs = parseConflicts('<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> x\r\n');
    expect(segs).toEqual([{ kind: 'conflict', ours: 'a\r\n', theirs: 'b\r\n', base: null, oursLabel: 'HEAD', theirsLabel: 'x' }]);
  });
});

describe('conflictLayout', () => {
  const file = '1\n2\n3\n4\n<<<<<<< HEAD\na\nb\n=======\nc\n>>>>>>> x\n5\n6\n<<<<<<< HEAD\nd\n=======\ne\nf\n>>>>>>> x\n7\n';
  const segs = parseConflicts(file);
  it('takes up to three unchanged lines around each conflict', () => {
    const l = conflictLayout(segs, {});
    expect(l[1].before).toEqual([2, 3, 4].map((n) => ({ no: n, text: String(n) })));
    expect(l[1].after.map((x) => x.text)).toEqual(['5', '6']);
    expect(l[3].before.map((x) => x.text)).toEqual(['5', '6']);
    expect(l[3].after).toEqual([{ no: 19, text: '7' }]);
  });
  it('numbers lines as they land in the result', () => {
    // Undecided: the markers are still in the result.
    expect(conflictLayout(segs, {})[1]).toMatchObject({ start: 5, ours: 6, theirs: 9 });
    const l = conflictLayout(segs, { 1: 'both-reverse', 3: 'ours' });
    expect(l[1]).toMatchObject({ start: 5, ours: 6, theirs: 5 });
    expect(l[1].after[0]).toEqual({ no: 8, text: '5' });
    expect(l[3]).toMatchObject({ start: 10, ours: 10, theirs: null });
    expect(l[3].after).toEqual([{ no: 11, text: '7' }]);
    const out = segs.map((s, i) => (s.kind === 'text' ? s.text : resolved(s, ({ 1: 'both-reverse', 3: 'ours' } as const)[i]))).join('');
    expect(out.split('\n')[10]).toBe('7');
  });
});

describe('conflict sides', () => {
  const base = { branch: 'main', opCommit: { sha: '119f9c7aaaa', subject: 'my change', name: null }, onto: { sha: 'abcdef1234', subject: 'up', name: 'origin/main' } };
  it('names the sides by what they are', () => {
    const rebase = conflictSides({ ...base, state: 'rebase' });
    expect([rebase.ours.label, rebase.theirs.label]).toEqual(['Upstream', 'Your commit']);
    expect(rebase.ours.title).toBe('Upstream (origin/main)');
    expect(rebase.theirs.title).toBe('Your commit (119f9c7 my change)');
    const merge = conflictSides({ ...base, state: 'merge', opCommit: { ...base.opCommit, name: 'feature' }, onto: null });
    expect([merge.ours.title, merge.theirs.title]).toEqual(['Current branch (main)', 'Incoming (feature)']);
    expect(conflictSides({ ...base, state: 'cherry-pick' }).theirs.label).toBe('Picked commit');
    expect(conflictSides({ ...base, state: null }, 'stash@{0}').theirs.title).toBe('Stash (stash@{0})');
    expect(conflictSides(null).ours.label).toBe('Ours');
  });
  it('describes deletion conflicts in those terms', () => {
    const rebase = conflictSides({ ...base, state: 'rebase' });
    expect(kindLabel('deleted-by-them', rebase)).toBe('deleted by your commit');
    expect(kindLabel('deleted-by-us', rebase)).toBe('deleted by upstream');
    expect(kindLabel('both-deleted', rebase)).toBe('deleted by both');
  });
});

describe('cleanTemplate', () => {
  it('drops comment lines and trims', () => {
    expect(cleanTemplate('# hint\n[robot] \n\nTested on:\n# end\n')).toBe('[robot] \n\nTested on:');
    expect(cleanTemplate(null)).toBe('');
  });
});

describe('parseTrack', () => {
  it('reads ahead/behind/gone', () => {
    expect(parseTrack('ahead 2, behind 3')).toEqual({ ahead: 2, behind: 3, gone: false });
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true });
  });
});

describe('undo entries', () => {
  const a = { head: 'aaa', branch: 'main' };
  const b = { head: 'bbb', branch: 'main' };
  it('headMove resets between the two commits', () => {
    expect(headMove('Commit', a, b, 'soft')).toMatchObject({ undo: [{ op: 'reset', args: ['aaa', 'soft'] }], redo: [{ op: 'reset', args: ['bbb', 'soft'] }] });
  });
  it('ignores no-ops and branch switches', () => {
    expect(headMove('Pull', a, a, 'keep')).toBeNull();
    expect(headMove('x', a, { head: 'bbb', branch: 'other' }, 'keep')).toBeNull();
    expect(checkoutMove('x', a, a)).toBeNull();
  });
  it('branchCreated checks back out before deleting', () => {
    const e = branchCreated('feat', 'aaa', a, { head: 'aaa', branch: 'feat' });
    expect(e.undo.map((s) => s.op)).toEqual(['checkout', 'deleteRef']);
    expect(e.redo.map((s) => s.op)).toEqual(['createRef', 'checkout']);
  });
  it('refsDeleted restores every ref', () => {
    const e = refsDeleted('x', [{ full: 'refs/heads/a', sha: '1' }, { full: 'refs/heads/b', sha: '2' }], a);
    expect(e.undo).toHaveLength(2);
    expect(sameHead(e.before, e.after)).toBe(true);
  });
});

describe('ignoreLiteral', () => {
  it('escapes glob characters and trailing spaces', () => {
    expect(ignoreLiteral('src/a[1]*?.txt')).toBe('src/a\\[1]\\*\\?.txt');
    expect(ignoreLiteral('back\\slash')).toBe('back\\\\slash');
    expect(ignoreLiteral('notes  ')).toBe('notes\\ \\ ');
    expect(ignoreLiteral('plain name.md')).toBe('plain name.md');
  });
});
