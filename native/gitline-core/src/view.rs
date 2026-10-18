// Display models shared by the native front ends: everything a UI needs to draw the commit graph and a
// diff, computed here so the toolkit code only maps them to widgets.
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use crate::diff::{LineKind, ParsedDiff, build_line_patch, parse_diff};
use crate::graph::{GraphRow, RESERVED, lane_color};
use crate::highlight::{Highlighter, PLAIN, Style, ThemeKind};
use crate::types::{Commit, Ref, RefType, WIP};
use crate::word_diff::{changed_ranges, pair_word_diffs};

// ---- diff ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Hunk,
    Add,
    Del,
    Ctx,
    Meta,
}

/// A run of text with one syntax style. `changed` marks the words that differ from the paired line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: Style,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: RowKind,
    pub hunk: usize,
    /// Index into the hunk's lines (None for the hunk header row).
    pub line: Option<usize>,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    /// The line's text without its +/-/space prefix (the header itself for hunk rows).
    pub text: String,
    pub spans: Vec<Span>,
}

pub struct DiffView {
    pub parsed: ParsedDiff,
    pub rows: Vec<DiffRow>,
}

const TAB: &str = "    ";

/// Cuts styled ranges at the edges of the changed ranges, so each span is one style and one mark.
fn split_spans(text: &str, styled: &[(Range<usize>, Style)], changed: &[(usize, usize)]) -> Vec<Span> {
    let mut cuts: Vec<usize> = vec![0, text.len()];
    for (r, _) in styled {
        cuts.extend([r.start, r.end]);
    }
    for &(a, b) in changed {
        cuts.extend([a, b]);
    }
    cuts.retain(|&c| c <= text.len() && text.is_char_boundary(c));
    cuts.sort_unstable();
    cuts.dedup();
    let style_at = |pos: usize| styled.iter().find(|(r, _)| r.contains(&pos)).map_or(PLAIN, |(_, s)| *s);
    let mut out: Vec<Span> = Vec::new();
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if a == b {
            continue;
        }
        let style = style_at(a);
        let changed = changed.iter().any(|&(s, e)| a >= s && a < e);
        let piece = text[a..b].replace('\t', TAB);
        match out.last_mut() {
            Some(last) if last.style == style && last.changed == changed => last.text.push_str(&piece),
            _ => out.push(Span { text: piece, style, changed }),
        }
    }
    out
}

impl DiffView {
    /// Parses and highlights a diff of the file at `path` (the path picks the syntax).
    pub fn build(diff: &str, path: &str, theme: ThemeKind) -> DiffView {
        DiffView::from_parsed(parse_diff(diff), path, theme, Some(Highlighter::global()))
    }

    /// Like `build`, without syntax highlighting.
    pub fn build_plain(diff: &str) -> DiffView {
        DiffView::from_parsed(parse_diff(diff), "", ThemeKind::Dark, None)
    }

    fn from_parsed(parsed: ParsedDiff, path: &str, theme: ThemeKind, hl: Option<&Highlighter>) -> DiffView {
        let mut rows = Vec::new();
        for (h, hunk) in parsed.hunks.iter().enumerate() {
            rows.push(DiffRow {
                kind: RowKind::Hunk,
                hunk: h,
                line: None,
                old_no: None,
                new_no: None,
                text: hunk.header.clone(),
                spans: vec![Span { text: hunk.header.clone(), style: PLAIN, changed: false }],
            });
            // Each side (old: context + removed, new: context + added) is highlighted as one text so
            // docstrings and block comments carry across lines; changed words are marked on top.
            let lines = &hunk.lines;
            let mut styled: Vec<Vec<(Range<usize>, Style)>> = lines.iter().map(|l| vec![(0..l.text.len(), PLAIN)]).collect();
            if let Some(hl) = hl {
                for side in [LineKind::Del, LineKind::Add] {
                    let idx: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].kind == side || lines[i].kind == LineKind::Ctx).collect();
                    let texts: Vec<&str> = idx.iter().map(|&i| lines[i].text.as_str()).collect();
                    for (k, spans) in hl.highlight_lines(&texts, path, theme).into_iter().enumerate() {
                        styled[idx[k]] = spans;
                    }
                }
            }
            let words: HashMap<usize, Vec<(usize, usize)>> =
                pair_word_diffs(lines).into_iter().map(|(i, s)| (i, changed_ranges(&s))).collect();
            for (i, l) in lines.iter().enumerate() {
                let kind = match l.kind {
                    LineKind::Add => RowKind::Add,
                    LineKind::Del => RowKind::Del,
                    LineKind::Ctx => RowKind::Ctx,
                    LineKind::Meta => RowKind::Meta,
                };
                let spans = if kind == RowKind::Meta {
                    vec![Span { text: l.text.clone(), style: PLAIN, changed: false }]
                } else {
                    split_spans(&l.text, &styled[i], words.get(&i).map_or(&[][..], Vec::as_slice))
                };
                rows.push(DiffRow { kind, hunk: h, line: Some(i), old_no: l.old_no, new_no: l.new_no, text: l.text.clone(), spans });
            }
        }
        DiffView { parsed, rows }
    }

    pub fn is_change(&self, row: usize) -> bool {
        matches!(self.rows.get(row).map(|r| r.kind), Some(RowKind::Add | RowKind::Del))
    }

    /// The text of rows `range` for the clipboard: code lines without their +/- prefix, hunk headers
    /// left out. (Inclusive bounds are easier for UIs that track an anchor and a cursor.)
    pub fn copy_text(&self, first: usize, last: usize) -> String {
        let (a, b) = (first.min(last), first.max(last).min(self.rows.len().saturating_sub(1)));
        if self.rows.is_empty() {
            return String::new();
        }
        self.rows[a..=b]
            .iter()
            .filter(|r| matches!(r.kind, RowKind::Add | RowKind::Del | RowKind::Ctx))
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The patch that stages (or, reversed, unstages) hunk `h`.
    pub fn hunk_patch(&self, h: usize) -> String {
        self.parsed.hunk_patch(h)
    }

    /// A patch with just the selected change rows, grouped by hunk. None if no change row is selected.
    pub fn lines_patch(&self, rows: impl IntoIterator<Item = usize>, reverse: bool) -> Option<String> {
        let mut by_hunk: Vec<HashSet<usize>> = vec![HashSet::new(); self.parsed.hunks.len()];
        for r in rows {
            if self.is_change(r) {
                let row = &self.rows[r];
                by_hunk[row.hunk].insert(row.line.unwrap());
            }
        }
        let mut patch = self.parsed.header.clone();
        let mut any = false;
        for (h, sel) in by_hunk.iter().enumerate() {
            if sel.is_empty() {
                continue;
            }
            any = true;
            patch.push_str(&build_line_patch("", &self.parsed.hunks[h], sel, reverse));
        }
        any.then_some(patch)
    }

    /// Whether this diff can be staged line by line: a text diff that isn't a merge's combined diff.
    pub fn can_apply(&self) -> bool {
        !self.parsed.binary && !self.parsed.combined && !self.parsed.hunks.is_empty()
    }
}

// ---- commit graph ----

/// Sizes of the graph column, matching src/components/CommitGraph.tsx.
pub const ROW_H: f32 = 34.0;
pub const LANE_W: f32 = 16.0;
pub const NODE_R: f32 = 5.0;
pub const GRAPH_PAD: f32 = 10.0;

pub fn lane_x(lane: usize) -> f32 {
    GRAPH_PAD + lane as f32 * LANE_W + LANE_W / 2.0
}

/// Width of the graph column for `max_lanes` lanes.
pub fn graph_width(max_lanes: usize) -> f32 {
    (max_lanes as f32 * LANE_W + GRAPH_PAD * 2.0).clamp(60.0, 420.0)
}

/// One line of the graph within a row, as a polyline in row-local pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphLine {
    pub points: Vec<(f32, f32)>,
    /// 0xRRGGBB
    pub color: u32,
    pub dashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Commit,
    Merge,
    Head,
    Wip,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphCell {
    pub lines: Vec<GraphLine>,
    pub node_x: f32,
    pub node_color: u32,
    pub node: NodeKind,
}

/// Metro-map lane segment: a vertical run joined to a 45° diagonal when there's room for one.
/// `diagonal_first` leaves the start point diagonally (branching off); otherwise the diagonal arrives
/// last (merging in).
pub fn metro(x1: f32, y1: f32, x2: f32, y2: f32, diagonal_first: bool) -> Vec<(f32, f32)> {
    let dx = (x2 - x1).abs();
    if dx == 0.0 || dx > y2 - y1 {
        return vec![(x1, y1), (x2, y2)];
    }
    if diagonal_first { vec![(x1, y1), (x2, y1 + dx), (x2, y2)] } else { vec![(x1, y1), (x1, y2 - dx), (x2, y2)] }
}

/// The lines and node of one graph row (a port of RowGraph in CommitGraph.tsx).
pub fn graph_cell(row: &GraphRow, parents: usize, is_head: bool, is_wip: bool) -> GraphCell {
    let mid = ROW_H / 2.0;
    let col = row.col;
    let in_color = |k: usize| lane_color(row.before_colors.get(k).copied().unwrap_or(k));
    let out_color = |k: usize| lane_color(row.after_colors.get(k).copied().unwrap_or(k));
    let color = lane_color(row.after_colors.get(col).or(row.before_colors.get(col)).copied().unwrap_or(col));
    let mut lines = Vec::new();
    for (k, lane) in row.before.iter().enumerate() {
        match *lane {
            None | Some(RESERVED) => {}
            // A lane merging in keeps its own color.
            Some(id) if id == row.id => {
                lines.push(GraphLine { points: metro(lane_x(k), 0.0, lane_x(col), mid, false), color: in_color(k), dashed: false })
            }
            Some(id) if row.after.get(k) == Some(&Some(id)) => {
                lines.push(GraphLine { points: vec![(lane_x(k), 0.0), (lane_x(k), ROW_H)], color: in_color(k), dashed: false })
            }
            _ => {}
        }
    }
    // Lanes leaving take the color of where they continue.
    for &j in &row.parent_cols {
        lines.push(GraphLine { points: metro(lane_x(col), mid, lane_x(j), ROW_H, true), color: out_color(j), dashed: is_wip });
    }
    let node = if is_wip {
        NodeKind::Wip
    } else if is_head {
        NodeKind::Head
    } else if parents > 1 {
        NodeKind::Merge
    } else {
        NodeKind::Commit
    };
    GraphCell { lines, node_x: lane_x(col), node_color: color, node }
}

/// A branch/tag label on a graph row: a local branch merged with its remote twin, a remote-only
/// branch, a tag, or a detached HEAD.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pill {
    pub label: String,
    pub kind: RefType,
    pub is_head: bool,
    /// For a local branch: whether a remote branch of the same name points here too.
    pub on_remote: bool,
}

/// Port of buildPills in CommitGraph.tsx.
pub fn pills(refs: &[&Ref], is_head_commit: bool, detached: bool) -> Vec<Pill> {
    let remotes: Vec<&&Ref> = refs.iter().filter(|r| r.kind == RefType::Remote).collect();
    let short = |r: &Ref| r.name.split_once('/').map_or(r.name.clone(), |(_, b)| b.to_string());
    let mut used: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for l in refs.iter().filter(|r| r.kind == RefType::Local) {
        let matching: Vec<_> = remotes.iter().filter(|r| short(r) == l.name).collect();
        used.extend(matching.iter().map(|r| r.full.as_str()));
        out.push(Pill { label: l.name.clone(), kind: RefType::Local, is_head: l.is_head, on_remote: !matching.is_empty() });
    }
    for r in remotes.iter().filter(|r| !used.contains(r.full.as_str())) {
        out.push(Pill { label: r.name.clone(), kind: RefType::Remote, is_head: false, on_remote: true });
    }
    for t in refs.iter().filter(|r| r.kind == RefType::Tag) {
        out.push(Pill { label: t.name.clone(), kind: RefType::Tag, is_head: false, on_remote: false });
    }
    if is_head_commit && detached {
        out.insert(0, Pill { label: "HEAD".into(), kind: RefType::Local, is_head: true, on_remote: false });
    }
    out.sort_by_key(|p| !p.is_head);
    out
}

/// The history list with its graph: an optional WIP row on top of the log, as the Electron app shows it.
pub struct History {
    pub commits: Vec<Commit>,
    pub graph: crate::graph::Graph,
    pub refs_by_sha: HashMap<String, Vec<Ref>>,
}

impl History {
    /// `head` is the checked-out commit; `wip` adds the "uncommitted changes" row above it.
    pub fn build(mut commits: Vec<Commit>, refs: Vec<Ref>, head: Option<&str>, trunk: Option<&str>, wip: bool) -> History {
        if wip {
            commits.insert(
                0,
                Commit {
                    sha: WIP.into(),
                    parents: head.map(|h| vec![h.to_string()]).unwrap_or_default(),
                    author: String::new(),
                    email: String::new(),
                    time: 0,
                    subject: String::new(),
                },
            );
        }
        let pairs: Vec<(&str, Vec<&str>)> =
            commits.iter().map(|c| (c.sha.as_str(), c.parents.iter().map(String::as_str).collect())).collect();
        let graph = crate::graph::compute_graph(&pairs, trunk);
        let mut refs_by_sha: HashMap<String, Vec<Ref>> = HashMap::new();
        for r in refs {
            refs_by_sha.entry(r.sha.clone()).or_default().push(r);
        }
        History { commits, graph, refs_by_sha }
    }

    pub fn pills(&self, i: usize, head: Option<&str>, detached: bool) -> Vec<Pill> {
        let c = &self.commits[i];
        let refs: Vec<&Ref> = self.refs_by_sha.get(&c.sha).map(|v| v.iter().collect()).unwrap_or_default();
        pills(&refs, head == Some(c.sha.as_str()), detached)
    }

    pub fn cell(&self, i: usize, head: Option<&str>) -> GraphCell {
        let c = &self.commits[i];
        graph_cell(&self.graph.rows[i], c.parents.len(), head == Some(c.sha.as_str()), c.sha == WIP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str =
        "diff --git a/f.rs b/f.rs\n--- a/f.rs\n+++ b/f.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    let x = 1;\n+    let x = 10;\n }\n";

    #[test]
    fn flattens_hunks_into_rows() {
        let v = DiffView::build(DIFF, "f.rs", ThemeKind::Dark);
        let kinds: Vec<_> = v.rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, vec![RowKind::Hunk, RowKind::Ctx, RowKind::Del, RowKind::Add, RowKind::Ctx]);
        // Spans rebuild the line, and only the changed number is marked.
        let add = &v.rows[3];
        assert_eq!(add.spans.iter().map(|s| s.text.as_str()).collect::<String>(), "    let x = 10;");
        let marked: Vec<_> = add.spans.iter().filter(|s| s.changed).map(|s| s.text.as_str()).collect();
        assert_eq!(marked, vec!["10"]);
        // `let` is keyword-coloured.
        assert!(add.spans.iter().any(|s| s.text == "let" && s.style.color.is_some()));
    }

    #[test]
    fn copies_code_without_prefixes() {
        let v = DiffView::build_plain(DIFF);
        assert_eq!(v.copy_text(0, 4), "fn main() {\n    let x = 1;\n    let x = 10;\n}");
        assert_eq!(v.copy_text(3, 2), "    let x = 1;\n    let x = 10;");
    }

    #[test]
    fn builds_patches_for_selected_rows() {
        let v = DiffView::build_plain(DIFF);
        assert_eq!(v.lines_patch([1], false), None);
        assert_eq!(
            v.lines_patch([3], false).unwrap(),
            "diff --git a/f.rs b/f.rs\n--- a/f.rs\n+++ b/f.rs\n@@ -1 +1 @@\n fn main() {\n     let x = 1;\n+    let x = 10;\n }\n"
        );
        assert!(v.hunk_patch(0).ends_with("+    let x = 10;\n }\n"));
    }

    #[test]
    fn expands_tabs() {
        let v = DiffView::build_plain("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-\tx\n+\ty\n");
        assert_eq!(v.rows[2].spans.iter().map(|s| s.text.as_str()).collect::<String>(), "    y");
    }

    #[test]
    fn draws_metro_lines() {
        assert_eq!(metro(0.0, 0.0, 16.0, 34.0, true), vec![(0.0, 0.0), (16.0, 16.0), (16.0, 34.0)]);
        assert_eq!(metro(16.0, 0.0, 0.0, 17.0, false), vec![(16.0, 0.0), (16.0, 1.0), (0.0, 17.0)]);
        assert_eq!(metro(0.0, 0.0, 0.0, 34.0, false).len(), 2);
    }

    fn r(full: &str, kind: RefType, is_head: bool) -> Ref {
        let name = full.splitn(3, '/').nth(2).unwrap().to_string();
        Ref { full: full.into(), name, kind, remote: None, sha: "s".into(), upstream: None, track: None, is_head }
    }

    #[test]
    fn merges_local_and_remote_pills() {
        let refs = [
            r("refs/remotes/origin/main", RefType::Remote, false),
            r("refs/heads/main", RefType::Local, true),
            r("refs/remotes/origin/other", RefType::Remote, false),
            r("refs/tags/v1", RefType::Tag, false),
        ];
        let refs: Vec<&Ref> = refs.iter().collect();
        let p = pills(&refs, true, false);
        assert_eq!(p.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["main", "origin/other", "v1"]);
        assert!(p[0].is_head && p[0].on_remote);
        assert_eq!(pills(&refs, true, true)[0].label, "HEAD");
    }

    #[test]
    fn builds_a_history_with_a_wip_row() {
        let c = |sha: &str, parents: &[&str]| Commit {
            sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            author: "a".into(),
            email: "e".into(),
            time: 0,
            subject: sha.into(),
        };
        let h = History::build(vec![c("b", &["a"]), c("a", &[])], vec![], Some("b"), Some("b"), true);
        assert_eq!(h.commits[0].sha, WIP);
        assert_eq!(h.cell(0, Some("b")).node, NodeKind::Wip);
        assert!(h.cell(0, Some("b")).lines[0].dashed);
        assert_eq!(h.cell(1, Some("b")).node, NodeKind::Head);
        assert_eq!(h.graph.rows[1].col, 0);
    }
}
