// The diff view. The text is a read-only text_editor, so it can be selected across lines with the mouse
// or keyboard and copied, like in a browser. iced's editor can colour text but not paint line
// backgrounds, so a canvas behind it paints the add/remove rows, the line-number gutters and the
// changed-word marks, for the rows in view only.
//
// The editor draws every line it holds on every frame (about 0.6s for 20,000 lines with the software
// renderer; about 60ms for 200), so it only holds a window of WINDOW rows around the viewport, pinned at their offset in a
// scrollable as tall as the whole diff. Scrolling near the window's edge moves the window.
use std::ops::Range;
use std::sync::Arc;

use gitline_core::highlight::Style as SpanStyle;
use gitline_core::view::{DiffView, RowKind};
use iced::advanced::text::highlighter::{self, Highlighter};
use iced::widget::canvas::{self, Frame, Geometry, Text};
use iced::widget::{Space, button, canvas as canvas_widget, column, pin, row, stack, text, text_editor};
use iced::{Color, Element, Font, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, mouse};

use crate::Message;
use crate::style::*;

pub const LINE_H: f32 = 20.0;
const FONT_SIZE: f32 = 12.0;
/// JetBrains Mono's advance is 600/1000 em, so a column is 7.2px at 12px.
const CHAR_W: f32 = FONT_SIZE * 0.6;
const NUM_W: f32 = 44.0;
const SIGN_W: f32 = 18.0;
pub const GUTTER: f32 = NUM_W * 2.0 + SIGN_W;

/// How many rows the editor holds, and how close to its edge the viewport may come before it moves.
pub const WINDOW: usize = 200;
const MARGIN: usize = 40;

/// The editor's text for rows `range`: each row as displayed (tabs expanded), one per line.
pub fn editor_text(view: &DiffView, range: Range<usize>) -> String {
    let mut s = String::new();
    for (i, r) in view.rows[range.clone()].iter().enumerate() {
        if i > 0 {
            s.push('\n');
        }
        for span in &r.spans {
            s.push_str(&span.text);
        }
    }
    s
}

/// Where the editor's window should start so rows `first..last` (the viewport) are well inside it, or
/// None if the window starting at `start` still covers them.
pub fn window_start(count: usize, start: usize, first: usize, last: usize) -> Option<usize> {
    let end = (start + WINDOW).min(count);
    let fits = (first >= start + MARGIN || start == 0) && (last + MARGIN <= end || end == count);
    if fits {
        return None;
    }
    let centered = first.saturating_sub((WINDOW - (last - first).min(WINDOW)) / 2);
    Some(centered.min(count.saturating_sub(WINDOW)))
}

/// Which rows the highlighter colours; a new `version` re-highlights (e.g. when syntax colours arrive
/// or the window moves). The editor's line 0 is row `start`.
#[derive(Clone)]
pub struct Colors {
    pub version: u64,
    pub view: Arc<DiffView>,
    pub start: usize,
}

impl PartialEq for Colors {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version
    }
}

/// Serves the core's precomputed spans to the editor, line by line.
pub struct DiffHighlighter {
    view: Arc<DiffView>,
    start: usize,
    line: usize,
}

#[derive(Clone, Copy)]
pub enum Hl {
    Span(SpanStyle),
    Header,
}

impl Highlighter for DiffHighlighter {
    type Settings = Colors;
    type Highlight = Hl;
    type Iterator<'a> = std::vec::IntoIter<(Range<usize>, Hl)>;

    fn new(settings: &Colors) -> Self {
        DiffHighlighter { view: settings.view.clone(), start: settings.start, line: 0 }
    }

    fn update(&mut self, settings: &Colors) {
        self.view = settings.view.clone();
        self.start = settings.start;
        self.line = 0;
    }

    fn change_line(&mut self, line: usize) {
        self.line = self.line.min(line);
    }

    fn highlight_line(&mut self, line: &str) -> Self::Iterator<'_> {
        let row = self.view.rows.get(self.start + self.line);
        self.line += 1;
        let Some(row) = row else { return Vec::new().into_iter() };
        if row.kind == RowKind::Hunk {
            return vec![(0..line.len(), Hl::Header)].into_iter();
        }
        let mut at = 0;
        let mut out = Vec::with_capacity(row.spans.len());
        for s in &row.spans {
            let end = (at + s.text.len()).min(line.len());
            out.push((at..end, Hl::Span(s.style)));
            at = end;
        }
        out.into_iter()
    }

    fn current_line(&self) -> usize {
        self.line
    }
}

pub fn to_format(h: &Hl, _: &Theme) -> highlighter::Format<Font> {
    match h {
        Hl::Header => highlighter::Format { color: Some(MUTED), font: None },
        Hl::Span(s) => highlighter::Format { color: s.color.map(hex), font: s.italic.then_some(MONO_ITALIC) },
    }
}

/// Row backgrounds, gutters and word marks for rows `first..last`, drawn from y = 0.
struct Backdrop {
    view: Arc<DiffView>,
    first: usize,
    last: usize,
}

impl canvas::Program<Message> for Backdrop {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, bounds: Rectangle, _: mouse::Cursor) -> Vec<Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let w = bounds.width;
        for (k, r) in self.view.rows[self.first..self.last].iter().enumerate() {
            let y = k as f32 * LINE_H;
            let (bg, ln_bg, word, sign, sign_color) = match r.kind {
                RowKind::Hunk => (BG_PANEL_2, BG_PANEL_2, None, "", MUTED),
                RowKind::Add => (ADD_BG, ADD_LN_BG, Some(ADD_WORD), "+", ADD_SIGN),
                RowKind::Del => (DEL_BG, DEL_LN_BG, Some(DEL_WORD), "-", DEL_SIGN),
                RowKind::Ctx | RowKind::Meta => (Color::TRANSPARENT, LN_BG, None, "", MUTED),
            };
            frame.fill_rectangle(Point::new(0.0, y), Size::new(w, LINE_H), bg);
            frame.fill_rectangle(Point::new(0.0, y), Size::new(NUM_W * 2.0, LINE_H), ln_bg);
            let num = |frame: &mut Frame, n: Option<u32>, x: f32| {
                if let Some(n) = n {
                    frame.fill_text(Text {
                        content: n.to_string(),
                        position: Point::new(x + NUM_W - 6.0, y + LINE_H / 2.0),
                        color: LN,
                        size: Pixels(11.0),
                        font: MONO,
                        align_x: iced::alignment::Horizontal::Right.into(),
                        align_y: iced::alignment::Vertical::Center,
                        ..Text::default()
                    });
                }
            };
            num(&mut frame, r.old_no, 0.0);
            num(&mut frame, r.new_no, NUM_W);
            if !sign.is_empty() {
                frame.fill_text(Text {
                    content: sign.into(),
                    position: Point::new(NUM_W * 2.0 + SIGN_W / 2.0, y + LINE_H / 2.0),
                    color: sign_color,
                    size: Pixels(FONT_SIZE),
                    font: MONO,
                    align_x: iced::alignment::Horizontal::Center.into(),
                    align_y: iced::alignment::Vertical::Center,
                    ..Text::default()
                });
            }
            if let Some(word) = word {
                let mut col = 0usize;
                for s in &r.spans {
                    let n = s.text.chars().count();
                    if s.changed {
                        frame.fill_rectangle(
                            Point::new(GUTTER + col as f32 * CHAR_W, y + 1.0),
                            Size::new(n as f32 * CHAR_W, LINE_H - 2.0),
                            word,
                        );
                    }
                    col += n;
                }
            }
        }
        vec![frame.into_geometry()]
    }
}

/// Rows `[first, last)` that are (nearly) in view.
pub fn visible(count: usize, offset: f32, height: f32) -> (usize, usize) {
    let first = ((offset / LINE_H).floor().max(0.0) as usize).saturating_sub(10).min(count);
    let last = (((offset + height) / LINE_H).ceil() as usize + 10).min(count);
    (first, last.max(first))
}

pub struct DiffProps<'a> {
    pub view: &'a Arc<DiffView>,
    pub content: &'a text_editor::Content,
    pub colors: Colors,
    /// The first row in the editor.
    pub start: usize,
    pub can_apply: bool,
    pub staged: bool,
    pub offset: f32,
    pub height: f32,
}

/// The scrolling body of the diff: backdrop, editor and the per-hunk buttons.
pub fn body<'a>(p: DiffProps<'a>) -> Element<'a, Message> {
    let count = p.view.rows.len();
    let (first, last) = visible(count, p.offset, p.height);
    let backdrop =
        pin(canvas_widget(Backdrop { view: p.view.clone(), first, last }).width(Length::Fill).height((last - first) as f32 * LINE_H))
            .y(first as f32 * LINE_H)
            .width(Length::Fill);
    let editor = pin(row![
        Space::new().width(GUTTER),
        text_editor(p.content)
            .on_action(Message::DiffAction)
            .font(MONO)
            .size(FONT_SIZE)
            .line_height(iced::widget::text::LineHeight::Absolute(Pixels(LINE_H)))
            .padding(0)
            .wrapping(text::Wrapping::None)
            .height(Length::Shrink)
            .style(diff_editor)
            .highlight_with::<DiffHighlighter>(p.colors, to_format),
    ])
    .y(p.start as f32 * LINE_H)
    .width(Length::Fill);
    let mut layers = stack![backdrop, editor].width(Length::Fill).height(count as f32 * LINE_H);
    if p.can_apply {
        let label = if p.staged { "Unstage hunk" } else { "Stage hunk" };
        for i in first..last {
            let r = &p.view.rows[i];
            if r.kind == RowKind::Hunk {
                let b = button(text(label).size(11)).padding([1, 8]).style(flat).on_press(Message::ApplyHunk(r.hunk));
                layers = layers.push(
                    pin(row![Space::new().width(Length::Fill), b, Space::new().width(8)].width(Length::Fill))
                        .y(i as f32 * LINE_H)
                        .width(Length::Fill),
                );
            }
        }
    }
    column![layers].into()
}

/// The editor's selection as a range of rows (whole lines touched by the selection or the cursor),
/// for an editor whose line 0 is row `start`.
pub fn selected_rows(content: &text_editor::Content, start: usize) -> (usize, usize) {
    let c = content.cursor();
    let a = c.position.line;
    let b = c.selection.map_or(a, |s| s.line);
    (start + a.min(b), start + a.max(b))
}

pub fn has_selection(content: &text_editor::Content) -> bool {
    content.cursor().selection.is_some_and(|s| s != content.cursor().position)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lays_the_diff_out_one_row_per_line() {
        let v = DiffView::build_plain("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-\tx\n+\ty\n");
        assert_eq!(editor_text(&v, 0..3), "@@ -1 +1 @@\n    x\n    y");
        assert_eq!(editor_text(&v, 1..3), "    x\n    y");
        let mut h = DiffHighlighter::new(&Colors { version: 0, view: Arc::new(v), start: 0 });
        assert!(matches!(h.highlight_line("@@ -1 +1 @@").next(), Some((_, Hl::Header))));
        // The indent, then "x" (word-marked against "y").
        let spans: Vec<_> = h.highlight_line("    x").map(|(r, _)| r).collect();
        assert_eq!(spans, vec![0..4, 4..5]);
        assert_eq!(h.current_line(), 2);
        h.change_line(1);
        assert_eq!(h.current_line(), 1);
    }

    #[test]
    fn moves_the_window_only_near_its_edges() {
        assert_eq!(window_start(20_000, 0, 0, 30), None);
        assert_eq!(window_start(20_000, 0, 100, 130), None);
        assert_eq!(window_start(20_000, 0, 150, 180), Some(65));
        assert_eq!(window_start(20_000, 65, 150, 180), None);
        assert_eq!(window_start(20_000, 65, 19_970, 20_000), Some(19_800));
        assert_eq!(window_start(100, 0, 70, 100), None);
    }

    #[test]
    fn builds_only_the_rows_in_view() {
        assert_eq!(visible(20_000, 0.0, 400.0), (0, 30));
        assert_eq!(visible(20_000, 20_000.0, 400.0), (990, 1030));
    }
}
