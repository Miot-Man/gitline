export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
  raw: string;
}

export interface ParsedDiff {
  header: string;
  hunks: Hunk[];
  binary: boolean;
  combined: boolean;
}

export function parseDiff(text: string): ParsedDiff {
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  const headerLines: string[] = [];
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let rawLines: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  let combined = false;

  const finish = () => {
    if (cur) {
      cur.raw = rawLines.join('\n') + '\n';
      hunks.push(cur);
    }
  };

  for (const line of all) {
    if (line.startsWith('@@')) {
      finish();
      combined = line.startsWith('@@@');
      const m = line.match(/^@@+ -(\d+)(?:,\d+)? \+(\d+)/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur = { header: line, lines: [], raw: '' };
      rawLines = [line];
      continue;
    }
    if (!cur) {
      headerLines.push(line);
      if (/^Binary files .* differ$/.test(line)) binary = true;
      continue;
    }
    rawLines.push(line);
    if (combined) {
      const marks = line.slice(0, 2);
      const type = marks.includes('+') ? 'add' : marks.includes('-') ? 'del' : 'ctx';
      cur.lines.push({ type, text: line.slice(2) });
    } else if (line.startsWith('+')) cur.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) cur.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith('\\')) cur.lines.push({ type: 'meta', text: line });
    else cur.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  finish();
  return { header: headerLines.join('\n') + '\n', hunks, binary, combined };
}
