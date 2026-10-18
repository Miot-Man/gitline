// Word-level highlighting for changed lines, ported from src/lib/wordDiff.ts: pairs each removed line
// with the added line that replaced it and marks just the words that differ.
use std::collections::HashMap;

use crate::diff::{DiffLine, LineKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub changed: bool,
}

/// Splits like the regex /\w+|\s+|[^\w\s]/g, with JavaScript's ASCII-only \w.
fn tokenize(s: &str) -> Vec<&str> {
    #[derive(PartialEq)]
    enum Class {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_ascii_alphanumeric() || c == '_' {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<Class> = None;
    for (i, c) in s.char_indices() {
        let k = class(c);
        let joins = matches!((&prev, &k), (Some(Class::Word), Class::Word) | (Some(Class::Space), Class::Space));
        if !joins && prev.is_some() {
            out.push(&s[start..i]);
            start = i;
        }
        prev = Some(k);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Longest common subsequence over tokens. Returns None when the lines are too long to compare
/// cheaply or share so little that word marks would just be noise.
pub fn word_diff(a: &str, b: &str) -> Option<(Vec<Segment>, Vec<Segment>)> {
    let x = tokenize(a);
    let y = tokenize(b);
    if x.is_empty() || y.is_empty() || x.len() * y.len() > 40_000 {
        return None;
    }
    let w = y.len() + 1;
    let mut dp = vec![0u32; (x.len() + 1) * w];
    for i in (0..x.len()).rev() {
        for j in (0..y.len()).rev() {
            dp[i * w + j] = if x[i] == y[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
        }
    }
    if (dp[0] as f64) / (x.len().max(y.len()) as f64) < 0.3 {
        return None;
    }

    let push = |out: &mut Vec<Segment>, text: &str, changed: bool| match out.last_mut() {
        Some(last) if last.changed == changed => last.text.push_str(text),
        _ => out.push(Segment { text: text.to_string(), changed }),
    };
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let (mut i, mut j) = (0, 0);
    while i < x.len() || j < y.len() {
        if i < x.len() && j < y.len() && x[i] == y[j] {
            push(&mut left, x[i], false);
            push(&mut right, y[j], false);
            i += 1;
            j += 1;
        } else if j >= y.len() || (i < x.len() && dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            push(&mut left, x[i], true);
            i += 1;
        } else {
            push(&mut right, y[j], true);
            j += 1;
        }
    }
    Some((left, right))
}

/// Byte ranges [start, end) of the changed segments. (The TypeScript version counts UTF-16 units;
/// bytes are what Rust slices by.)
pub fn changed_ranges(segments: &[Segment]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 0;
    for s in segments {
        if s.changed {
            out.push((pos, pos + s.text.len()));
        }
        pos += s.text.len();
    }
    out
}

/// Word segments for each paired -/+ line in a hunk, keyed by the line's index.
pub fn pair_word_diffs(lines: &[DiffLine]) -> HashMap<usize, Vec<Segment>> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != LineKind::Del {
            i += 1;
            continue;
        }
        let (mut dels, mut adds) = (Vec::new(), Vec::new());
        while i < lines.len() && lines[i].kind == LineKind::Del {
            dels.push(i);
            i += 1;
        }
        while i < lines.len() && lines[i].kind == LineKind::Add {
            adds.push(i);
            i += 1;
        }
        for (&d, &a) in dels.iter().zip(&adds) {
            if let Some((l, r)) = word_diff(&lines[d].text, &lines[a].text) {
                out.insert(d, l);
                out.insert(a, r);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_diff;

    fn changed(segs: &[Segment]) -> Vec<&str> {
        segs.iter().filter(|s| s.changed).map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn marks_only_the_words_that_changed() {
        let (a, b) = word_diff("set_speed(FAST_SPEED);", "set_speed(SLOW_SPEED);").unwrap();
        assert_eq!(changed(&a), vec!["FAST_SPEED"]);
        assert_eq!(changed(&b), vec!["SLOW_SPEED"]);
        assert_eq!(a.iter().map(|s| s.text.as_str()).collect::<String>(), "set_speed(FAST_SPEED);");
    }

    #[test]
    fn gives_up_on_lines_that_share_almost_nothing() {
        assert!(word_diff("int a = 1;", "return foo(bar, baz) && qux;").is_none());
    }

    #[test]
    fn pairs_removed_and_added_lines_within_a_change_block() {
        let d = parse_diff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-let x = 1;\n-let y = 2;\n+let x = 10;\n+let y = 2;\n");
        let words = pair_word_diffs(&d.hunks[0].lines);
        assert_eq!(changed(&words[&0]), vec!["1"]);
        assert_eq!(changed(&words[&2]), vec!["10"]);
    }

    #[test]
    fn tokenizes_like_the_regex() {
        assert_eq!(tokenize("ab  c(é)"), vec!["ab", "  ", "c", "(", "é", ")"]);
    }

    #[test]
    fn reports_byte_ranges() {
        let (_, b) = word_diff("x = 1", "x = 22").unwrap();
        assert_eq!(changed_ranges(&b), vec![(4, 6)]);
    }
}
