// Parsing and resolving git conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>).

export type Choice = 'ours' | 'theirs' | 'both' | 'both-reverse';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'conflict'; ours: string; theirs: string; base: string | null; oursLabel: string; theirsLabel: string };

// Splits a file into plain text and conflict blocks, keeping line endings. Handles diff3 base sections.
export function parseConflicts(content: string): Segment[] {
  const lines = content.split(/(?<=\n)/);
  const segs: Segment[] = [];
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) {
      text += lines[i];
      continue;
    }
    const oursLabel = lines[i].slice(7).trim();
    let ours = '';
    let base: string | null = null;
    let theirs = '';
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('|||||||') && !lines[j].startsWith('=======')) ours += lines[j++];
    if (j < lines.length && lines[j].startsWith('|||||||')) {
      base = '';
      j++;
      while (j < lines.length && !lines[j].startsWith('=======')) base += lines[j++];
    }
    j++;
    while (j < lines.length && !lines[j].startsWith('>>>>>>>')) theirs += lines[j++];
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

export const hasMarkers = (s: string) => /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(s);
