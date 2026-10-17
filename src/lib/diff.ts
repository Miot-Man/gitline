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

// Builds a one-hunk patch containing only the selected +/- lines (indices into hunk.lines).
// Unselected changes become context or are dropped so the patch applies to the right side:
//   forward (stage): unselected '-' lines stay as context, unselected '+' lines are dropped;
//   reverse (unstage / discard, applied with --reverse): unselected '+' lines stay, unselected '-' are dropped.
// Each change block (a run of '-' then '+') is reordered so kept lines land where they were:
// context that sits after the first selected line moves past the other side's lines.
// Hunk counts are left out; the patch is applied with `git apply --recount`.
export function buildLinePatch(fileHeader: string, hunk: Hunk, selected: Set<number>, reverse: boolean): string {
  // Attach "\ No newline at end of file" markers to the line they follow.
  const items: { line: DiffLine; idx: number; noEol: boolean }[] = [];
  hunk.lines.forEach((l, i) => {
    if (l.type === 'meta') {
      if (items.length) items[items.length - 1].noEol = true;
    } else items.push({ line: l, idx: i, noEol: false });
  });

  const out: string[] = [];
  const emit = (it: (typeof items)[number], prefix: string) => {
    out.push(prefix + it.line.text);
    if (it.noEol) out.push('\\ No newline at end of file');
  };

  for (let i = 0; i < items.length; ) {
    if (items[i].line.type === 'ctx') {
      emit(items[i++], ' ');
      continue;
    }
    const dels: typeof items = [];
    const adds: typeof items = [];
    while (i < items.length && items[i].line.type === 'del') dels.push(items[i++]);
    while (i < items.length && items[i].line.type === 'add') adds.push(items[i++]);
    const sel = (it: (typeof items)[number]) => selected.has(it.idx);

    if (!reverse) {
      const first = dels.findIndex(sel);
      const pre = first < 0 ? dels : dels.slice(0, first);
      const rest = first < 0 ? [] : dels.slice(first);
      pre.forEach((d) => emit(d, ' '));
      rest.filter(sel).forEach((d) => emit(d, '-'));
      adds.filter(sel).forEach((a) => emit(a, '+'));
      rest.filter((d) => !sel(d)).forEach((d) => emit(d, ' '));
    } else {
      const first = adds.findIndex(sel);
      const pre = first < 0 ? adds : adds.slice(0, first);
      const rest = first < 0 ? [] : adds.slice(first);
      pre.forEach((a) => emit(a, ' '));
      dels.filter(sel).forEach((d) => emit(d, '-'));
      rest.forEach((a) => emit(a, sel(a) ? '+' : ' '));
    }
  }

  const m = hunk.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  const header = m ? `@@ -${m[1]} +${m[2]} @@${m[3]}` : hunk.header;
  return `${fileHeader}${header}\n${out.join('\n')}\n`;
}
