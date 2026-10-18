// The diff view, laid out like src/components/DiffView.tsx: each hunk is a bordered card with a header
// (its range and Stage/Discard buttons) above its lines.
//
// The text is one read-only text_editor across all hunks, so it can be selected across lines with the
// mouse or keyboard and copied, like in a browser. iced's editor can colour text but not paint line
// backgrounds, so a canvas behind it paints the cards, rows, line-number gutters and changed-word marks
// (for the rows in view only). The editor's lines are fixed-height slots: blank slots stand in for
// hunk headers and the gaps between cards.
//
// The editor draws every line it holds on every frame (about 0.6s for 20,000 lines with the software
// renderer), so it only holds a window of WINDOW slots around the viewport, pinned at their offset in a
// scrollable as tall as the whole diff. Scrolling near the window's edge moves the window.
use std::ops::Range;
use std::sync::Arc;

use gitline_core::highlight::Style as SpanStyle;
use gitline_core::view::{DiffView, RowKind};
use iced::advanced::text::highlighter::{self, Highlighter};
use iced::widget::canvas::{self, Frame, Geometry, Text};
use iced::widget::{Space, button, canvas as canvas_widget, column, container, pin, row, stack, text, text_editor};
use iced::{Alignment, Color, Element, Font, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, mouse};

use crate::Message;
use crate::style::*;

pub const LINE_H: f32 = 19.0;
const FONT_SIZE: f32 = 12.0;
/// JetBrains Mono's advance is 600/1000 em, so a column is 7.2px at 12px.
const CHAR_W: f32 = FONT_SIZE * 0.6;
/// `.diff-body` padding.
pub const PAD_X: f32 = 12.0;
pub const PAD_TOP: f32 = 10.0;
const PAD_BOTTOM: f32 = 40.0;
const NUM_W: f32 = 52.0;
const SIGN_W: f32 = 20.0;
/// From a card's inner left edge to the code.
const GUTTER: f32 = NUM_W * 2.0 + SIGN_W;

/// How many slots the editor holds, and how close to its edge the viewport may come before it moves.
pub const WINDOW: usize = 200;
const MARGIN: usize = 40;

/// What one editor line (one LINE_H slot) shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// The space between two hunk cards.
    Gap,
    /// A hunk's header, two slots tall.
    Header { hunk: usize, top: bool },
    /// A row of the diff view (an index into `DiffView::rows`).
    Row(usize),
}

pub struct Layout {
    pub slots: Vec<Slot>,
}

impl Layout {
    pub fn new(view: &DiffView) -> Layout {
        let mut slots = Vec::with_capacity(view.rows.len() + view.parsed.hunks.len() * 3);
        for (i, r) in view.rows.iter().enumerate() {
            if r.kind == RowKind::Hunk {
                if r.hunk > 0 {
                    slots.push(Slot::Gap);
                }
                slots.push(Slot::Header { hunk: r.hunk, top: true });
                slots.push(Slot::Header { hunk: r.hunk, top: false });
            } else {
                slots.push(Slot::Row(i));
            }
        }
        Layout { slots }
    }

    pub fn height(&self) -> f32 {
        PAD_TOP + self.slots.len() as f32 * LINE_H + PAD_BOTTOM
    }

    /// The slot of hunk `h`'s header.
    pub fn header_slot(&self, h: usize) -> Option<usize> {
        self.slots.iter().position(|s| *s == Slot::Header { hunk: h, top: true })
    }

    /// The first and last diff rows within slots `a..=b`, if any.
    pub fn rows_between(&self, a: usize, b: usize) -> Option<(usize, usize)> {
        let end = (b + 1).min(self.slots.len());
        let rows = || self.slots[a.min(end)..end].iter().filter_map(|s| if let Slot::Row(r) = s { Some(*r) } else { None });
        Some((rows().next()?, rows().next_back()?))
    }
}

/// The editor's text for slots `range`: each row as displayed (tabs expanded), blank for the rest.
pub fn editor_text(view: &DiffView, layout: &Layout, range: Range<usize>) -> String {
    let mut s = String::new();
    for (i, slot) in layout.slots[range].iter().enumerate() {
        if i > 0 {
            s.push('\n');
        }
        if let Slot::Row(r) = slot {
            for span in &view.rows[*r].spans {
                s.push_str(&span.text);
            }
        }
    }
    s
}

/// Where the editor's window should start so slots `first..last` (the viewport) are well inside it, or
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

/// Which slots the highlighter colours; a new `version` re-highlights (e.g. when syntax colours arrive
/// or the window moves). The editor's line 0 is slot `start`.
#[derive(Clone)]
pub struct Colors {
    pub version: u64,
    pub view: Arc<DiffView>,
    pub layout: Arc<Layout>,
    pub start: usize,
}

impl PartialEq for Colors {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version
    }
}

/// Serves the core's precomputed spans to the editor, line by line.
pub struct DiffHighlighter {
    colors: Colors,
    line: usize,
}

impl Highlighter for DiffHighlighter {
    type Settings = Colors;
    type Highlight = SpanStyle;
    type Iterator<'a> = std::vec::IntoIter<(Range<usize>, SpanStyle)>;

    fn new(settings: &Colors) -> Self {
        DiffHighlighter { colors: settings.clone(), line: 0 }
    }

    fn update(&mut self, settings: &Colors) {
        self.colors = settings.clone();
        self.line = 0;
    }

    fn change_line(&mut self, line: usize) {
        self.line = self.line.min(line);
    }

    fn highlight_line(&mut self, line: &str) -> Self::Iterator<'_> {
        let slot = self.colors.layout.slots.get(self.colors.start + self.line).copied();
        self.line += 1;
        let Some(Slot::Row(r)) = slot else { return Vec::new().into_iter() };
        let mut at = 0;
        let spans = &self.colors.view.rows[r].spans;
        let mut out = Vec::with_capacity(spans.len());
        for s in spans {
            let end = (at + s.text.len()).min(line.len());
            out.push((at..end, s.style));
            at = end;
        }
        out.into_iter()
    }

    fn current_line(&self) -> usize {
        self.line
    }
}

pub fn to_format(s: &SpanStyle, _: &Theme) -> highlighter::Format<Font> {
    highlighter::Format { color: s.color.map(hex), font: s.italic.then_some(MONO_ITALIC) }
}

/// Cards, row backgrounds, gutters and word marks for slots `first..last`, drawn from y = 0.
struct Backdrop {
    view: Arc<DiffView>,
    layout: Arc<Layout>,
    first: usize,
    last: usize,
    /// Room the header buttons take on the right, which the hunk range is cut short of.
    buttons_w: f32,
}

/// Draws `content` vertically centred on a LINE_H slot at `y`.
fn label(frame: &mut Frame, content: String, x: f32, y: f32, color: Color, size: f32, right: bool) {
    frame.fill_text(Text {
        content,
        position: Point::new(x, y + LINE_H / 2.0),
        color,
        size: Pixels(size),
        font: MONO,
        align_x: if right { iced::alignment::Horizontal::Right.into() } else { iced::alignment::Horizontal::Left.into() },
        align_y: iced::alignment::Vertical::Center,
        ..Text::default()
    });
}

impl canvas::Program<Message> for Backdrop {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, bounds: Rectangle, _: mouse::Cursor) -> Vec<Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let (x0, w) = (PAD_X, bounds.width - PAD_X * 2.0);
        let slots = &self.layout.slots;
        for k in self.first..self.last {
            let y = (k - self.first) as f32 * LINE_H;
            match slots[k] {
                Slot::Gap => continue,
                Slot::Header { hunk, top } => {
                    frame.fill_rectangle(Point::new(x0, y), Size::new(w, LINE_H), BG_PANEL_2);
                    if top {
                        frame.fill_rectangle(Point::new(x0, y), Size::new(w, 1.0), BORDER_SOFT);
                        let header = self
                            .view
                            .rows
                            .iter()
                            .find(|r| r.kind == RowKind::Hunk && r.hunk == hunk)
                            .map(|r| r.text.as_str())
                            .unwrap_or("");
                        // Centred across both of the header's slots, cut short of the buttons with "…".
                        let room = ((w - 24.0 - self.buttons_w) / CHAR_W).max(1.0) as usize;
                        let shown = if header.chars().count() > room {
                            format!("{}…", header.chars().take(room.saturating_sub(1)).collect::<String>())
                        } else {
                            header.to_string()
                        };
                        label(&mut frame, shown, x0 + 12.0, y + LINE_H / 2.0, MUTED, 12.0, false);
                    }
                }
                Slot::Row(r) => {
                    let row = &self.view.rows[r];
                    let (bg, ln_bg, ln, word, sign, sign_color) = match row.kind {
                        RowKind::Add => (ADD_BG, ADD_LN_BG, ADD_LN, Some(ADD_WORD), "+", ADD_SIGN),
                        RowKind::Del => (DEL_BG, DEL_LN_BG, DEL_LN, Some(DEL_WORD), "-", DEL_SIGN),
                        _ => (Color::TRANSPARENT, LN_BG, LN, None, "", MUTED),
                    };
                    frame.fill_rectangle(Point::new(x0, y), Size::new(w, LINE_H), bg);
                    frame.fill_rectangle(Point::new(x0, y), Size::new(NUM_W * 2.0, LINE_H), ln_bg);
                    let no = |n: Option<u32>| n.map_or_else(String::new, |n| n.to_string());
                    label(&mut frame, no(row.old_no), x0 + NUM_W - 8.0, y, ln, FONT_SIZE, true);
                    label(&mut frame, no(row.new_no), x0 + NUM_W * 2.0 - 8.0, y, ln, FONT_SIZE, true);
                    label(&mut frame, sign.into(), x0 + NUM_W * 2.0 + 6.0, y, sign_color, FONT_SIZE, false);
                    if let Some(word) = word {
                        let mut col = 0usize;
                        for s in &row.spans {
                            let n = s.text.chars().count();
                            if s.changed {
                                let at = Point::new(x0 + GUTTER + col as f32 * CHAR_W, y + 1.0);
                                frame.fill_rectangle(at, Size::new(n as f32 * CHAR_W, LINE_H - 2.0), word);
                            }
                            col += n;
                        }
                    }
                    // The card's bottom edge under a hunk's last row.
                    if !matches!(slots.get(k + 1), Some(Slot::Row(_))) {
                        frame.fill_rectangle(Point::new(x0, y + LINE_H - 1.0), Size::new(w, 1.0), BORDER_SOFT);
                    }
                }
            }
            // The card's side edges.
            frame.fill_rectangle(Point::new(x0, y), Size::new(1.0, LINE_H), BORDER_SOFT);
            frame.fill_rectangle(Point::new(x0 + w - 1.0, y), Size::new(1.0, LINE_H), BORDER_SOFT);
        }
        vec![frame.into_geometry()]
    }
}

/// Slots `[first, last)` that are (nearly) in view.
pub fn visible(count: usize, offset: f32, height: f32) -> (usize, usize) {
    let top = offset - PAD_TOP;
    let first = ((top / LINE_H).floor().max(0.0) as usize).saturating_sub(10).min(count);
    let last = (((top + height) / LINE_H).ceil().max(0.0) as usize + 10).min(count);
    (first, last.max(first))
}

/// What the hunk headers offer: Stage/Unstage (and Discard) per hunk, or the same for the selected
/// lines in the hunk the selection starts in.
pub struct HunkActions {
    pub staged: bool,
    /// The hunk with the selection, and how many changed lines are selected.
    pub selection: Option<(usize, usize)>,
}

pub struct DiffProps<'a> {
    pub view: &'a Arc<DiffView>,
    pub layout: &'a Arc<Layout>,
    pub content: &'a text_editor::Content,
    pub colors: Colors,
    /// The first slot in the editor.
    pub start: usize,
    /// None when the diff can't be staged by hunk (a commit's diff, or whitespace hidden).
    pub actions: Option<HunkActions>,
    pub offset: f32,
    pub height: f32,
}

fn xs(label: String, style: fn(&Theme, button::Status) -> button::Style, msg: Message) -> Element<'static, Message> {
    button(text(label).size(11)).padding([2, 8]).style(style).on_press(msg).into()
}

/// The scrolling body of the diff: backdrop, editor and the hunk headers' buttons.
pub fn body<'a>(p: DiffProps<'a>) -> Element<'a, Message> {
    let count = p.layout.slots.len();
    let (first, last) = visible(count, p.offset, p.height);
    // Roughly what the header buttons take: "Discard Hunk" and "Stage Hunk", or Clear/Discard/Stage lines.
    let buttons_w = match &p.actions {
        None => 0.0,
        Some(HunkActions { selection: Some(_), .. }) => 260.0,
        Some(HunkActions { staged: true, .. }) => 100.0,
        Some(_) => 180.0,
    };
    let backdrop = pin(canvas_widget(Backdrop { view: p.view.clone(), layout: p.layout.clone(), first, last, buttons_w })
        .width(Length::Fill)
        .height((last - first) as f32 * LINE_H))
    .y(PAD_TOP + first as f32 * LINE_H)
    .width(Length::Fill);
    let editor = pin(row![
        Space::new().width(PAD_X + 1.0 + GUTTER),
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
        Space::new().width(PAD_X + 10.0),
    ])
    .y(PAD_TOP + p.start as f32 * LINE_H)
    .width(Length::Fill);
    let mut layers = stack![backdrop, editor].width(Length::Fill).height(p.layout.height());
    if let Some(a) = &p.actions {
        for k in first..last {
            let Slot::Header { hunk, top: true } = p.layout.slots[k] else { continue };
            let buttons: Vec<Element<_>> = match a.selection {
                Some((h, n)) if h == hunk => {
                    let lines = format!("{n} line{}", if n == 1 { "" } else { "s" });
                    let mut b = vec![xs("Clear".into(), plain, Message::ClearDiffSelection)];
                    if !a.staged {
                        b.push(xs(format!("Discard {lines}"), danger_ghost, Message::NotInSpike("Discarding lines")));
                        b.push(xs(format!("Stage {lines}"), stage, Message::ApplyLines));
                    } else {
                        b.push(xs(format!("Unstage {lines}"), unstage, Message::ApplyLines));
                    }
                    b
                }
                _ if !a.staged => vec![
                    xs("Discard Hunk".into(), danger_ghost, Message::NotInSpike("Discarding a hunk")),
                    xs("Stage Hunk".into(), stage, Message::ApplyHunk(hunk)),
                ],
                _ => vec![xs("Unstage Hunk".into(), unstage, Message::ApplyHunk(hunk))],
            };
            let bar = row![Space::new().width(Length::Fill), row(buttons).spacing(6), Space::new().width(PAD_X + 8.0)]
                .height(LINE_H * 2.0)
                .align_y(Alignment::Center);
            layers = layers.push(pin(bar.width(Length::Fill)).y(PAD_TOP + k as f32 * LINE_H).width(Length::Fill));
        }
    }
    column![layers].into()
}

/// The editor's selection as a range of slots (whole lines touched by the selection or the cursor),
/// for an editor whose line 0 is slot `start`.
pub fn selected_slots(content: &text_editor::Content, start: usize) -> (usize, usize) {
    let c = content.cursor();
    let a = c.position.line;
    let b = c.selection.map_or(a, |s| s.line);
    (start + a.min(b), start + a.max(b))
}

pub fn has_selection(content: &text_editor::Content) -> bool {
    content.cursor().selection.is_some_and(|s| s != content.cursor().position)
}

/// `.diff-message`: shown in place of a diff with no text to show.
pub fn message<'a>(m: &'a str) -> Element<'a, Message> {
    container(text(m).color(MUTED)).padding(30).center_x(Length::Fill).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_HUNKS: &str = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-\tx\n+\ty\n@@ -9 +9 @@\n-a\n+b\n";

    #[test]
    fn lays_hunks_out_as_cards() {
        let v = DiffView::build_plain(TWO_HUNKS);
        let l = Layout::new(&v);
        use Slot::*;
        assert_eq!(
            l.slots,
            vec![
                Header { hunk: 0, top: true },
                Header { hunk: 0, top: false },
                Row(1),
                Row(2),
                Gap,
                Header { hunk: 1, top: true },
                Header { hunk: 1, top: false },
                Row(4),
                Row(5),
            ]
        );
        assert_eq!(editor_text(&v, &l, 0..4), "\n\n    x\n    y");
        assert_eq!(l.header_slot(1), Some(5));
        assert_eq!(l.rows_between(0, 1), None);
        assert_eq!(l.rows_between(1, 8), Some((1, 5)));
    }

    #[test]
    fn highlights_rows_and_leaves_headers_blank() {
        let v = Arc::new(DiffView::build_plain(TWO_HUNKS));
        let l = Arc::new(Layout::new(&v));
        let mut h = DiffHighlighter::new(&Colors { version: 0, view: v, layout: l, start: 0 });
        assert_eq!(h.highlight_line("").count(), 0);
        assert_eq!(h.highlight_line("").count(), 0);
        // The indent, then "x" (word-marked against "y").
        assert_eq!(h.highlight_line("    x").map(|(r, _)| r).collect::<Vec<_>>(), vec![0..4, 4..5]);
        assert_eq!(h.current_line(), 3);
        h.change_line(1);
        assert_eq!(h.current_line(), 1);
    }

    #[test]
    fn moves_the_window_only_near_its_edges() {
        assert_eq!(window_start(20_000, 0, 100, 130), None);
        assert_eq!(window_start(20_000, 0, 150, 180), Some(65));
        assert_eq!(window_start(20_000, 65, 150, 180), None);
        assert_eq!(window_start(20_000, 65, 19_970, 20_000), Some(19_800));
        assert_eq!(window_start(100, 0, 70, 100), None);
    }

    #[test]
    fn builds_only_the_slots_in_view() {
        assert_eq!(visible(20_000, 0.0, 400.0), (0, 31));
        assert_eq!(visible(20_000, 19_010.0, 380.0), (990, 1030));
    }
}
