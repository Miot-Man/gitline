// Word-level highlighting for changed lines: pairs each removed line with the added line that
// replaced it and marks just the words that differ.
import type { DiffLine } from './diff';

export interface Segment {
  text: string;
  changed: boolean;
}

const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

// Longest common subsequence over tokens. Returns null when the lines are too long to compare
// cheaply or share so little that word marks would just be noise.
export function wordDiff(a: string, b: string): [Segment[], Segment[]] | null {
  const x = tokenize(a);
  const y = tokenize(b);
  if (!x.length || !y.length || x.length * y.length > 40_000) return null;
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  if (dp[0][0] / Math.max(x.length, y.length) < 0.3) return null;

  const left: Segment[] = [];
  const right: Segment[] = [];
  const push = (out: Segment[], text: string, changed: boolean) => {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      push(left, x[i++], false);
      push(right, y[j++], false);
    } else if (j >= y.length || (i < x.length && dp[i + 1][j] >= dp[i][j + 1])) push(left, x[i++], true);
    else push(right, y[j++], true);
  }
  return [left, right];
}

// Character ranges [start, end) of the changed segments.
export function changedRanges(segments: Segment[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (const s of segments) {
    if (s.changed) out.push([pos, pos + s.text.length]);
    pos += s.text.length;
  }
  return out;
}

// Word segments for each paired -/+ line in a hunk, keyed by the line's index.
export function pairWordDiffs(lines: DiffLine[]): Map<number, Segment[]> {
  const out = new Map<number, Segment[]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(i++);
    while (i < lines.length && lines[i].type === 'add') adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = wordDiff(lines[dels[k]].text, lines[adds[k]].text);
      if (!d) continue;
      out.set(dels[k], d[0]);
      out.set(adds[k], d[1]);
    }
  }
  return out;
}
