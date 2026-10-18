// Syntax highlighting with syntect, using bat's syntax set (via two-face) for wide language coverage
// and a theme built from the Electron app's --syn-* colours (src/styles.css), so code looks the same.
use std::ops::Range;
use std::str::FromStr;
use std::sync::OnceLock;

use syntect::highlighting::{
    Color, FontStyle, HighlightState, Highlighter as SynHighlighter, RangedHighlightIterator, ScopeSelectors, StyleModifier, Theme,
    ThemeItem, ThemeSettings,
};
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

/// A run of text in one colour. `color` is 0xRRGGBB, or None for the default text colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Style {
    pub color: Option<u32>,
    pub italic: bool,
}

pub const PLAIN: Style = Style { color: None, italic: false };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeKind {
    Dark,
    Light,
}

struct Palette {
    keyword: u32,
    string: u32,
    number: u32,
    comment: u32,
    func: u32,
    kind: u32,
    attr: u32,
}

const DARK: Palette =
    Palette { keyword: 0xc792ea, string: 0x6cb6ff, number: 0xf4a259, comment: 0x6e7781, func: 0x82aaff, kind: 0xffcb6b, attr: 0x80cbc4 };
const LIGHT: Palette =
    Palette { keyword: 0x8a3fb5, string: 0x0a5cad, number: 0xb5530e, comment: 0x8a8f98, func: 0x1f5fbf, kind: 0x9a6a00, attr: 0x00796b };

/// Scope selectors, the palette colour they take, and whether they're italic.
type ScopeRule = (&'static str, fn(&Palette) -> u32, bool);

// Which TextMate scopes map to which of the app's highlight.js classes.
const SCOPES: &[ScopeRule] = &[
    ("comment, punctuation.definition.comment, meta.preprocessor, meta.annotation, meta.attribute", |p| p.comment, true),
    ("string, string.regexp, constant.character, markup.inserted, markup.raw", |p| p.string, false),
    ("constant.numeric, constant.other.color, constant.other.placeholder", |p| p.number, false),
    ("keyword, storage, constant.language, support.constant, variable.language", |p| p.keyword, false),
    ("keyword.operator, punctuation.accessor", |_| 0, false), // operators stay plain text, as in hljs
    ("entity.name.function, support.function, meta.function-call entity, markup.heading, entity.name.section", |p| p.func, false),
    (
        "entity.name.type, entity.name.class, entity.name.struct, entity.name.enum, entity.name.trait, entity.name.interface, support.type, support.class, entity.other.inherited-class, storage.type.primitive",
        |p| p.kind,
        false,
    ),
    (
        "entity.other.attribute-name, entity.name.tag, support.type.property-name, variable.other.member, meta.mapping.key string, entity.name.label",
        |p| p.attr,
        false,
    ),
];

fn rgb(c: u32) -> Color {
    Color { r: (c >> 16) as u8, g: (c >> 8) as u8, b: c as u8, a: 0xff }
}

fn build_theme(p: &Palette) -> Theme {
    let scopes = SCOPES
        .iter()
        .map(|(sel, color, italic)| {
            let c = color(p);
            ThemeItem {
                scope: ScopeSelectors::from_str(sel).expect("valid scope selector"),
                style: StyleModifier {
                    // 0 marks "plain": a fully transparent foreground we map back to None.
                    foreground: Some(if c == 0 { Color { r: 0, g: 0, b: 0, a: 0 } } else { rgb(c) }),
                    background: None,
                    font_style: Some(if *italic { FontStyle::ITALIC } else { FontStyle::empty() }),
                },
            }
        })
        .collect();
    Theme {
        settings: ThemeSettings { foreground: Some(Color { r: 0, g: 0, b: 0, a: 0 }), ..Default::default() },
        scopes,
        ..Default::default()
    }
}

pub struct Highlighter {
    syntaxes: SyntaxSet,
    dark: Theme,
    light: Theme,
}

/// Built-in guesses the syntax set doesn't make on its own (from src/lib/highlight.ts).
const BY_EXT: &[(&str, &str)] =
    &[("ino", "cpp"), ("pde", "cpp"), ("mts", "ts"), ("cts", "ts"), ("cjs", "js"), ("mjs", "js"), ("jsonc", "json")];

impl Highlighter {
    /// The shared highlighter. Loading the syntax set takes a moment, so it's done once.
    pub fn global() -> &'static Highlighter {
        static H: OnceLock<Highlighter> = OnceLock::new();
        H.get_or_init(Highlighter::new)
    }

    pub fn new() -> Highlighter {
        Highlighter { syntaxes: two_face::syntax::extra_newlines(), dark: build_theme(&DARK), light: build_theme(&LIGHT) }
    }

    /// The syntax for a file path: by file name (Makefile, Dockerfile), then by extension.
    pub fn syntax_for(&self, path: &str) -> Option<&SyntaxReference> {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        let ext = ext.as_deref().map(|e| BY_EXT.iter().find(|(k, _)| *k == e).map_or(e, |(_, v)| v));
        self.syntaxes
            .find_syntax_by_extension(name)
            .or_else(|| self.syntaxes.find_syntax_by_extension(&name.to_ascii_lowercase()))
            .or_else(|| ext.and_then(|e| self.syntaxes.find_syntax_by_extension(e)))
            .filter(|s| s.name != "Plain Text")
    }

    pub fn language_name(&self, path: &str) -> Option<&str> {
        self.syntax_for(path).map(|s| s.name.as_str())
    }

    /// Highlights consecutive lines as one text, so constructs spanning lines (docstrings, block
    /// comments) are coloured correctly. Returns byte ranges into each line with their style.
    pub fn highlight_lines<S: AsRef<str>>(&self, lines: &[S], path: &str, theme: ThemeKind) -> Vec<Vec<(Range<usize>, Style)>> {
        let plain = |l: &str| vec![(0..l.len(), PLAIN)];
        let Some(syntax) = self.syntax_for(path) else { return lines.iter().map(|l| plain(l.as_ref())).collect() };
        let theme = if theme == ThemeKind::Dark { &self.dark } else { &self.light };
        let hl = SynHighlighter::new(theme);
        let mut parse = ParseState::new(syntax);
        let mut state = HighlightState::new(&hl, ScopeStack::new());
        let mut buf = String::new();
        lines
            .iter()
            .map(|line| {
                let line = line.as_ref();
                // Very long lines (minified files) are slow to parse and unreadable anyway.
                if line.len() > 4000 {
                    return plain(line);
                }
                buf.clear();
                buf.push_str(line);
                buf.push('\n');
                let Ok(ops) = parse.parse_line(&buf, &self.syntaxes) else { return plain(line) };
                RangedHighlightIterator::new(&mut state, &ops, &buf, &hl)
                    .filter(|(_, _, r)| r.start < line.len())
                    .map(|(style, _, r)| {
                        let fg = style.foreground;
                        let color = (fg.a != 0).then_some((fg.r as u32) << 16 | (fg.g as u32) << 8 | fg.b as u32);
                        (r.start..r.end.min(line.len()), Style { color, italic: style.font_style.contains(FontStyle::ITALIC) })
                    })
                    .collect()
            })
            .collect()
    }
}

impl Default for Highlighter {
    fn default() -> Self {
        Highlighter::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn colored<'a>(line: &'a str, spans: &[(Range<usize>, Style)], color: u32) -> Vec<&'a str> {
        spans.iter().filter(|(_, s)| s.color == Some(color)).map(|(r, _)| line[r.clone()].trim()).filter(|t| !t.is_empty()).collect()
    }

    #[test]
    fn picks_a_syntax_from_the_file_name() {
        let h = Highlighter::global();
        assert_eq!(h.language_name("src/main.rs"), Some("Rust"));
        assert_eq!(h.language_name("src/app.tsx"), Some("TypeScriptReact"));
        assert_eq!(h.language_name("firmware/main.c"), Some("C"));
        assert_eq!(h.language_name("Makefile"), Some("Makefile"));
        assert_eq!(h.language_name("robot/robot.ino"), Some("C++"));
        assert_eq!(h.language_name("notes.unknown"), None);
    }

    #[test]
    fn colours_keywords_strings_and_comments() {
        let h = Highlighter::global();
        let line = r#"const s = "<b>"; // note"#;
        let spans = &h.highlight_lines(&[line], "a.js", ThemeKind::Dark)[0];
        assert!(colored(line, spans, DARK.keyword).contains(&"const"));
        assert!(colored(line, spans, DARK.string).iter().any(|t| t.contains("<b>")));
        assert!(spans.iter().any(|(r, s)| s.italic && line[r.clone()].contains("note")));
        // The ranges cover the line exactly once.
        assert_eq!(spans.iter().map(|(r, _)| r.len()).sum::<usize>(), line.len());
    }

    #[test]
    fn carries_a_python_docstring_across_lines() {
        let h = Highlighter::global();
        let lines = [
            "#!/usr/bin/env python3",
            r#""""Fit the simulated motors."#,
            "",
            "Reads the log and writes from the model.",
            r#"""""#,
            "",
            "import math",
        ];
        let out = h.highlight_lines(&lines, "fit.py", ThemeKind::Dark);
        assert_eq!(out.len(), lines.len());
        // The prose inside the docstring is coloured like its opening line, not as keywords. (bat's
        // grammar scopes docstrings as documentation comments, where highlight.js calls them strings.)
        let open = out[1][0].1;
        assert_ne!(open, PLAIN);
        assert!(out[3].iter().all(|(_, s)| *s == open));
        assert!(colored(lines[6], &out[6], DARK.keyword).contains(&"import"));
    }

    #[test]
    fn leaves_unknown_files_plain() {
        let h = Highlighter::global();
        assert_eq!(h.highlight_lines(&["x"], "a.zzz", ThemeKind::Light), vec![vec![(0..1, PLAIN)]]);
    }
}
