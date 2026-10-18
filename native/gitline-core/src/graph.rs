// Lane layout for the commit graph, ported from src/lib/graph.ts. Commits must be ordered
// children-before-parents.
//
// Lanes hold small integer ids instead of shas: every sha seen (commits and parents) is interned once,
// so a 5,000-commit graph doesn't copy strings for every lane of every row.
use std::collections::HashMap;

/// What a lane holds: the id of the commit it's waiting for, or nothing.
pub type Lane = Option<u32>;

/// Placeholder holding the leftmost lane for the trunk branch until its tip appears. Never drawn.
pub const RESERVED: u32 = u32::MAX;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRow {
    /// This commit's id, as used in the lanes.
    pub id: u32,
    pub col: usize,
    /// Lane contents entering this row.
    pub before: Vec<Lane>,
    /// Lane contents leaving this row.
    pub after: Vec<Lane>,
    /// Lanes this commit's parents continue in.
    pub parent_cols: Vec<usize>,
    /// Color index of each lane entering this row.
    pub before_colors: Vec<usize>,
    /// Color index of each lane leaving this row.
    pub after_colors: Vec<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Graph {
    pub rows: Vec<GraphRow>,
    pub max_lanes: usize,
}

/// `trunk` (e.g. main's tip) keeps the leftmost lane, so branches ahead of it get their own lane
/// instead of being drawn on top of it.
pub fn compute_graph<S: AsRef<str>>(commits: &[(S, Vec<S>)], trunk: Option<&str>) -> Graph {
    let mut ids: HashMap<&str, u32> = HashMap::with_capacity(commits.len() * 2);
    // Commit ids first, so a commit's id is its index.
    for (sha, _) in commits {
        intern(sha.as_ref(), &mut ids);
    }
    let trunk_id = trunk.and_then(|t| ids.get(t).copied());

    let mut lanes: Vec<Lane> = Vec::new();
    // Each new branch line gets its own color, even when it reuses a freed column.
    let mut colors: Vec<usize> = Vec::new();
    let mut next_color = 0;
    if trunk_id.is_some() {
        lanes.push(Some(RESERVED));
        colors.push(next_color);
        next_color += 1;
    }
    let mut rows = Vec::with_capacity(commits.len());
    let mut max_lanes = 1;

    let free_lane = |lanes: &mut Vec<Lane>, colors: &mut Vec<usize>, next_color: &mut usize| -> usize {
        let i = match lanes.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                lanes.push(None);
                lanes.len() - 1
            }
        };
        if colors.len() <= i {
            colors.resize(i + 1, 0);
        }
        colors[i] = *next_color;
        *next_color += 1;
        i
    };

    for (idx, (_, parents)) in commits.iter().enumerate() {
        let id = idx as u32;
        let before = lanes.clone();
        let before_colors = colors[..lanes.len().min(colors.len())].to_vec();
        let mut col: Option<usize> = (Some(id) == trunk_id && lanes.first() == Some(&Some(RESERVED))).then_some(0);
        for (k, lane) in lanes.iter_mut().enumerate() {
            if *lane != Some(id) || Some(k) == col {
                continue;
            }
            if col.is_none() {
                col = Some(k);
            } else {
                *lane = None; // another child's lane merges into this commit
            }
        }
        let col = match col {
            Some(c) => c,
            None => free_lane(&mut lanes, &mut colors, &mut next_color),
        };

        let parent_ids: Vec<u32> = parents.iter().map(|p| intern(p.as_ref(), &mut ids)).collect();
        let mut parent_cols = Vec::with_capacity(parent_ids.len());
        lanes[col] = parent_ids.first().copied();
        if !parent_ids.is_empty() {
            parent_cols.push(col);
        }
        for &p in parent_ids.iter().skip(1) {
            let j = match lanes.iter().position(|l| *l == Some(p)) {
                Some(j) => j,
                None => {
                    let j = free_lane(&mut lanes, &mut colors, &mut next_color);
                    lanes[j] = Some(p);
                    j
                }
            };
            parent_cols.push(j);
        }
        while lanes.last() == Some(&None) {
            lanes.pop();
        }
        colors.resize(lanes.len().max(col + 1), 0);

        max_lanes = max_lanes.max(before.len()).max(lanes.len()).max(col + 1);
        rows.push(GraphRow {
            id,
            col,
            before,
            after: lanes.clone(),
            parent_cols,
            before_colors,
            after_colors: colors[..lanes.len()].to_vec(),
        });
    }
    Graph { rows, max_lanes }
}

fn intern<'a>(s: &'a str, ids: &mut HashMap<&'a str, u32>) -> u32 {
    let n = ids.len() as u32;
    *ids.entry(s).or_insert(n)
}

pub const LANE_COLORS: [u32; 10] = [0x2ec4b6, 0xf4a259, 0xa594f9, 0x4f8cff, 0xe86a92, 0x7bd389, 0xe3c35a, 0x5bc0eb, 0xff8c61, 0xc792ea];

/// Color 0 is reserved for the first line drawn so side branches never blend into it. Returns 0xRRGGBB.
pub fn lane_color(i: usize) -> u32 {
    if i == 0 { LANE_COLORS[0] } else { LANE_COLORS[1 + (i - 1) % (LANE_COLORS.len() - 1)] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_a_branch_on_its_own_lane_and_merges_it_back() {
        // m merges f into b; both descend from a.
        let commits = vec![("m", vec!["b", "f"]), ("f", vec!["a"]), ("b", vec!["a"]), ("a", vec![])];
        let g = compute_graph(&commits, None);
        assert_eq!(g.max_lanes, 2);
        assert_eq!(g.rows[0].parent_cols, vec![0, 1]);
        assert_eq!(g.rows[1].col, 1);
        assert_eq!(g.rows[3].col, 0);
    }

    #[test]
    fn keeps_the_trunk_on_the_left() {
        // feature is ahead of main; main's tip should still be drawn in lane 0.
        let commits = vec![("f2", vec!["f1"]), ("f1", vec!["m"]), ("m", vec!["root"]), ("root", vec![])];
        let g = compute_graph(&commits, Some("m"));
        assert_eq!(g.rows[0].col, 1);
        assert_eq!(g.rows[2].col, 0);
        assert_eq!(g.rows[0].before, vec![Some(RESERVED)]);
    }

    #[test]
    fn handles_parents_outside_the_list() {
        let commits = vec![("b", vec!["a"])];
        let g = compute_graph(&commits, None);
        assert_eq!(g.rows[0].after, vec![Some(1)]);
    }

    #[test]
    fn colors_skip_the_trunk_color() {
        assert_eq!(lane_color(0), 0x2ec4b6);
        assert_eq!(lane_color(1), 0xf4a259);
        assert_eq!(lane_color(10), 0xf4a259);
    }
}
