// Lane layout for the commit graph. Commits must be ordered children-before-parents.

export interface GraphRow {
  col: number;
  before: (string | null)[]; // lane contents entering this row
  after: (string | null)[]; // lane contents leaving this row
  parentCols: number[]; // lanes this commit's parents continue in
  beforeColors: number[]; // color index of each lane entering this row
  afterColors: number[]; // color index of each lane leaving this row
}

// Placeholder holding the leftmost lane for the trunk branch until its tip appears. Never drawn.
export const RESERVED = '\0reserved';

// `trunk` (e.g. main's tip) keeps the leftmost lane, so branches ahead of it get their own lane
// instead of being drawn on top of it.
export function computeGraph(commits: { sha: string; parents: string[] }[], trunk?: string | null) {
  const lanes: (string | null)[] = [];
  // Each new branch line gets its own color, even when it reuses a freed column.
  const colors: number[] = [];
  let nextColor = 0;
  if (trunk && commits.some((c) => c.sha === trunk)) {
    lanes.push(RESERVED);
    colors.push(nextColor++);
  }
  const rows: GraphRow[] = [];
  let maxLanes = 1;

  const freeLane = () => {
    let i = lanes.indexOf(null);
    if (i < 0) {
      lanes.push(null);
      i = lanes.length - 1;
    }
    colors[i] = nextColor++;
    return i;
  };

  for (const c of commits) {
    const before = lanes.slice();
    const beforeColors = colors.slice(0, lanes.length);
    let col = c.sha === trunk && lanes[0] === RESERVED ? 0 : -1;
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] !== c.sha || k === col) continue;
      if (col < 0) col = k;
      else lanes[k] = null; // another child's lane merges into this commit
    }
    if (col < 0) col = freeLane();

    const parentCols: number[] = [];
    lanes[col] = c.parents[0] ?? null;
    if (c.parents.length) parentCols.push(col);
    for (let i = 1; i < c.parents.length; i++) {
      const p = c.parents[i];
      let j = lanes.indexOf(p);
      if (j < 0) {
        j = freeLane();
        lanes[j] = p;
      }
      parentCols.push(j);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    colors.length = Math.max(lanes.length, col + 1);

    rows.push({ col, before, after: lanes.slice(), parentCols, beforeColors, afterColors: colors.slice(0, lanes.length) });
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
  }
  return { rows, maxLanes };
}

export const LANE_COLORS = [
  '#15a0bf',
  '#0669f7',
  '#8e00c2',
  '#c517b6',
  '#d90171',
  '#cd0101',
  '#f25d2e',
  '#f2ca33',
  '#7bd938',
  '#2ece9d',
];

// Color 0 is reserved for the first line drawn so side branches never blend into it.
export const laneColor = (i: number) => (i === 0 ? LANE_COLORS[0] : LANE_COLORS[1 + ((i - 1) % (LANE_COLORS.length - 1))]);
