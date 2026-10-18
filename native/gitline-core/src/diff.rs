// Diff parsing and line-level patches for staging single lines, ported from src/lib/diff.ts.
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Add,
    Del,
    Ctx,
    /// `\ No newline at end of file`
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
    /// The hunk as git printed it, header included, ending in a newline. Applying it stages the hunk.
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiff {
    /// Everything before the first hunk (`diff --git`, `index`, `---`, `+++`), ending in a newline.
    pub header: String,
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    /// A merge's combined diff (`@@@`), which can't be applied as a patch.
    pub combined: bool,
}

impl ParsedDiff {
    /// A patch with just one hunk of this diff.
    pub fn hunk_patch(&self, i: usize) -> String {
        format!("{}{}", self.header, self.hunks[i].raw)
    }
}

/// Reads the two numbers of `@@ -12,3 +14,4 @@` (or `@@@ -1 -1 +1 @@@`: the first old and the new start).
fn hunk_starts(line: &str) -> Option<(u32, u32)> {
    let rest = line.trim_start_matches('@');
    let rest = rest.strip_prefix(" -")?;
    let old_end = rest.find(|c: char| !c.is_ascii_digit())?;
    let old: u32 = rest[..old_end].parse().ok()?;
    let new_at = rest.find(" +")? + 2;
    let new_rest = &rest[new_at..];
    let new_end = new_rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(new_rest.len());
    let new: u32 = new_rest[..new_end].parse().ok()?;
    Some((old, new))
}

pub fn parse_diff(text: &str) -> ParsedDiff {
    let mut all: Vec<&str> = text.split('\n').collect();
    if all.last() == Some(&"") {
        all.pop();
    }
    let mut header_lines: Vec<&str> = Vec::new();
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut cur: Option<Hunk> = None;
    let mut raw: Vec<&str> = Vec::new();
    let (mut old_no, mut new_no) = (0u32, 0u32);
    let mut binary = false;
    let mut combined = false;

    let finish = |cur: &mut Option<Hunk>, raw: &mut Vec<&str>, hunks: &mut Vec<Hunk>| {
        if let Some(mut h) = cur.take() {
            h.raw = raw.join("\n") + "\n";
            hunks.push(h);
        }
        raw.clear();
    };

    for line in all {
        if line.starts_with("@@") {
            finish(&mut cur, &mut raw, &mut hunks);
            combined = line.starts_with("@@@");
            (old_no, new_no) = hunk_starts(line).unwrap_or((0, 0));
            cur = Some(Hunk { header: line.to_string(), lines: Vec::new(), raw: String::new() });
            raw.push(line);
            continue;
        }
        let Some(h) = cur.as_mut() else {
            header_lines.push(line);
            if line.starts_with("Binary files ") && line.ends_with(" differ") {
                binary = true;
            }
            continue;
        };
        raw.push(line);
        let push = |h: &mut Hunk, kind, text: &str, old_no, new_no| h.lines.push(DiffLine { kind, text: text.to_string(), old_no, new_no });
        if combined {
            let marks: String = line.chars().take(2).collect();
            let kind = if marks.contains('+') {
                LineKind::Add
            } else if marks.contains('-') {
                LineKind::Del
            } else {
                LineKind::Ctx
            };
            push(h, kind, line.get(2..).unwrap_or(""), None, None);
        } else if let Some(t) = line.strip_prefix('+') {
            push(h, LineKind::Add, t, None, Some(new_no));
            new_no += 1;
        } else if let Some(t) = line.strip_prefix('-') {
            push(h, LineKind::Del, t, Some(old_no), None);
            old_no += 1;
        } else if line.starts_with('\\') {
            push(h, LineKind::Meta, line, None, None);
        } else {
            push(h, LineKind::Ctx, line.get(1..).unwrap_or(""), Some(old_no), Some(new_no));
            old_no += 1;
            new_no += 1;
        }
    }
    finish(&mut cur, &mut raw, &mut hunks);
    ParsedDiff { header: header_lines.join("\n") + "\n", hunks, binary, combined }
}

/// Builds a one-hunk patch containing only the selected +/- lines (indices into `hunk.lines`).
/// Unselected changes become context or are dropped so the patch applies to the right side:
///   forward (stage): unselected '-' lines stay as context, unselected '+' lines are dropped;
///   reverse (unstage / discard, applied with --reverse): unselected '+' lines stay, unselected '-' are dropped.
/// Each change block (a run of '-' then '+') is reordered so kept lines land where they were:
/// context that sits after the first selected line moves past the other side's lines.
/// Hunk counts are left out; the patch is applied with `git apply --recount`.
pub fn build_line_patch(file_header: &str, hunk: &Hunk, selected: &HashSet<usize>, reverse: bool) -> String {
    struct Item<'a> {
        line: &'a DiffLine,
        idx: usize,
        no_eol: bool,
    }
    // Attach "\ No newline at end of file" markers to the line they follow.
    let mut items: Vec<Item> = Vec::new();
    for (i, l) in hunk.lines.iter().enumerate() {
        if l.kind == LineKind::Meta {
            if let Some(last) = items.last_mut() {
                last.no_eol = true;
            }
        } else {
            items.push(Item { line: l, idx: i, no_eol: false });
        }
    }

    let mut out: Vec<String> = Vec::new();
    let emit = |out: &mut Vec<String>, it: &Item, prefix: char| {
        out.push(format!("{prefix}{}", it.line.text));
        if it.no_eol {
            out.push("\\ No newline at end of file".into());
        }
    };
    let sel = |it: &Item| selected.contains(&it.idx);

    let mut i = 0;
    while i < items.len() {
        if items[i].line.kind == LineKind::Ctx {
            emit(&mut out, &items[i], ' ');
            i += 1;
            continue;
        }
        let mut dels: Vec<&Item> = Vec::new();
        let mut adds: Vec<&Item> = Vec::new();
        while i < items.len() && items[i].line.kind == LineKind::Del {
            dels.push(&items[i]);
            i += 1;
        }
        while i < items.len() && items[i].line.kind == LineKind::Add {
            adds.push(&items[i]);
            i += 1;
        }

        if !reverse {
            let first = dels.iter().position(|d| sel(d)).unwrap_or(dels.len());
            let (pre, rest) = dels.split_at(first);
            pre.iter().for_each(|d| emit(&mut out, d, ' '));
            rest.iter().filter(|d| sel(d)).for_each(|d| emit(&mut out, d, '-'));
            adds.iter().filter(|a| sel(a)).for_each(|a| emit(&mut out, a, '+'));
            rest.iter().filter(|d| !sel(d)).for_each(|d| emit(&mut out, d, ' '));
        } else {
            let first = adds.iter().position(|a| sel(a)).unwrap_or(adds.len());
            let (pre, rest) = adds.split_at(first);
            pre.iter().for_each(|a| emit(&mut out, a, ' '));
            dels.iter().filter(|d| sel(d)).for_each(|d| emit(&mut out, d, '-'));
            rest.iter().for_each(|a| emit(&mut out, a, if sel(a) { '+' } else { ' ' }));
        }
    }

    format!("{file_header}{}\n{}\n", strip_counts(&hunk.header), out.join("\n"))
}

/// `@@ -1,3 +1,4 @@ fn` -> `@@ -1 +1 @@ fn`
fn strip_counts(header: &str) -> String {
    let parse = || -> Option<String> {
        let rest = header.strip_prefix("@@ -")?;
        let end = rest.find(" @@")?;
        let (ranges, tail) = (&rest[..end], &rest[end + 3..]);
        let (old, new) = ranges.split_once(" +")?;
        let start = |r: &str| r.split(',').next().filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).map(str::to_string);
        Some(format!("@@ -{} +{} @@{tail}", start(old)?, start(new)?))
    };
    parse().unwrap_or_else(|| header.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n";

    #[test]
    fn numbers_lines_on_both_sides() {
        let d = parse_diff(DIFF);
        assert!(!d.binary);
        assert_eq!(d.hunks.len(), 1);
        let got: Vec<_> = d.hunks[0].lines.iter().map(|l| (l.kind, l.old_no, l.new_no)).collect();
        assert_eq!(
            got,
            vec![
                (LineKind::Ctx, Some(1), Some(1)),
                (LineKind::Del, Some(2), None),
                (LineKind::Add, None, Some(2)),
                (LineKind::Ctx, Some(3), Some(3)),
            ]
        );
        assert_eq!(d.hunks[0].raw, "@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n");
    }

    #[test]
    fn detects_binary_files() {
        assert!(parse_diff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary);
    }

    #[test]
    fn reads_combined_diffs() {
        let d = parse_diff("diff --cc f\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n -b\n++c\n");
        assert!(d.combined);
        let kinds: Vec<_> = d.hunks[0].lines.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, vec![LineKind::Del, LineKind::Del, LineKind::Add]);
        assert_eq!(d.hunks[0].lines[2].text, "c");
    }

    #[test]
    fn keeps_unselected_deletions_as_context_when_staging() {
        let hunk = &parse_diff(DIFF).hunks[0];
        let patch = build_line_patch("H\n", hunk, &HashSet::from([2]), false); // only "+B"
        assert_eq!(patch, "H\n@@ -1 +1 @@ fn\n a\n b\n+B\n c\n");
    }

    #[test]
    fn keeps_unselected_additions_as_context_when_reversing() {
        let hunk = &parse_diff(DIFF).hunks[0];
        let patch = build_line_patch("H\n", hunk, &HashSet::from([1]), true); // only "-b"
        // Kept additions come first, so the restored line lands after them.
        assert_eq!(patch, "H\n@@ -1 +1 @@ fn\n a\n B\n-b\n c\n");
    }

    #[test]
    fn carries_no_newline_markers() {
        let d = parse_diff("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n");
        let patch = build_line_patch(&d.header, &d.hunks[0], &HashSet::from([2]), false);
        assert_eq!(patch, "--- a/f\n+++ b/f\n@@ -1 +1 @@\n a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n");
    }
}
