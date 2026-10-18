// The history list: only the rows in view are built (the list scrolls over a spacer of the full
// height), and each row's lanes are drawn on a small canvas.
use gitline_core::format::relative_time;
use gitline_core::view::{GraphCell, History, NodeKind, Pill, ROW_H};
use gitline_core::{RefType, WIP};
use iced::widget::canvas::{self, Frame, Geometry, LineCap, LineDash, LineJoin, Path, Stroke};
use iced::widget::{Space, button, canvas as canvas_widget, column, container, row, text};
use iced::{Background, Border, Color, Element, Font, Length, Point, Rectangle, Renderer, Theme, mouse};

use crate::Message;
use crate::style::*;

const REFS_W: f32 = 150.0;

struct CellView(GraphCell);

impl canvas::Program<Message> for CellView {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, bounds: Rectangle, _: mouse::Cursor) -> Vec<Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let cell = &self.0;
        for line in &cell.lines {
            let path = Path::new(|b| {
                for (i, &(x, y)) in line.points.iter().enumerate() {
                    if i == 0 { b.move_to(Point::new(x, y)) } else { b.line_to(Point::new(x, y)) }
                }
            });
            let mut stroke =
                Stroke::default().with_width(2.5).with_color(hex(line.color)).with_line_cap(LineCap::Round).with_line_join(LineJoin::Round);
            if line.dashed {
                stroke.line_dash = LineDash { segments: &[3.0, 3.0], offset: 0 };
            }
            frame.stroke(&path, stroke);
        }
        let c = Point::new(cell.node_x, ROW_H / 2.0);
        let color = hex(cell.node_color);
        let ring = |frame: &mut Frame, r: f32, fill: Color, stroke: Color, dashed: bool| {
            let circle = Path::circle(c, r);
            frame.fill(&circle, fill);
            let mut s = Stroke::default().with_width(2.5).with_color(stroke);
            if dashed {
                s.line_dash = LineDash { segments: &[2.5, 2.0], offset: 0 };
                s.width = 2.0;
            }
            frame.stroke(&circle, s);
        };
        match cell.node {
            NodeKind::Wip => ring(&mut frame, 5.0, BG_GRAPH, ORANGE, true),
            NodeKind::Head => {
                frame.stroke(&Path::circle(c, 8.5), Stroke::default().with_width(2.5).with_color(Color { a: 0.35, ..color }));
                frame.fill(&Path::circle(c, 5.5), color);
            }
            NodeKind::Merge => {
                ring(&mut frame, 5.5, BG_GRAPH, color, false);
                frame.fill(&Path::circle(c, 2.0), color);
            }
            NodeKind::Commit => ring(&mut frame, 5.0, BG_GRAPH, color, false),
        }
        vec![frame.into_geometry()]
    }
}

fn pill(p: Pill, tag: Color) -> Element<'static, Message> {
    let (bg, border, fg) = match (p.kind, p.is_head) {
        (RefType::Tag, _) => (Color::TRANSPARENT, MUTED, TEXT),
        (_, true) => (tag, tag, BG),
        _ => (Color { a: 0.14, ..tag }, Color { a: 0.45, ..tag }, tag),
    };
    container(text(p.label).font(MONO).size(11).color(fg))
        .padding([1, 6])
        .max_width(140)
        .style(move |_| container::Style {
            background: Some(Background::Color(bg)),
            border: Border { color: border, width: 1.0, radius: 0.0.into() },
            ..Default::default()
        })
        .into()
}

pub struct GraphProps<'a> {
    pub history: &'a History,
    pub head: Option<&'a str>,
    pub detached: bool,
    pub selected: usize,
    pub graph_width: f32,
    pub wip_label: String,
    /// Scroll offset and height of the list's viewport.
    pub offset: f32,
    pub height: f32,
}

/// Rows `[first, last)` that are (nearly) in view.
pub fn visible(count: usize, offset: f32, height: f32) -> (usize, usize) {
    let first = ((offset / ROW_H).floor().max(0.0) as usize).saturating_sub(5).min(count);
    let last = (((offset + height) / ROW_H).ceil() as usize + 5).min(count);
    (first, last.max(first))
}

pub fn view<'a>(p: GraphProps<'a>) -> Element<'a, Message> {
    let count = p.history.commits.len();
    let (first, last) = visible(count, p.offset, p.height);
    let now = gitline_core::format::now();
    let mut rows = column![Space::new().height(first as f32 * ROW_H)];
    for i in first..last {
        let c = &p.history.commits[i];
        let cell = p.history.cell(i, p.head);
        let lane = hex(cell.node_color);
        let selected = i == p.selected;
        let wip = c.sha == WIP;
        let pills = row(p.history.pills(i, p.head, p.detached).into_iter().map(|x| pill(x, lane))).spacing(4);
        let subject = if wip {
            text(p.wip_label.clone()).color(ORANGE).font(Font { style: iced::font::Style::Italic, ..SANS })
        } else {
            text(c.subject.clone()).color(if selected { TEXT_STRONG } else { TEXT })
        };
        let line = row![
            container(pills).width(REFS_W).padding([0, 8]).clip(true),
            canvas_widget(CellView(cell)).width(p.graph_width).height(ROW_H),
            container(subject.wrapping(text::Wrapping::None)).width(Length::Fill).padding([0, 10]).clip(true),
            container(text(c.author.clone()).size(12).color(MUTED).wrapping(text::Wrapping::None)).width(120).clip(true),
            container(text(if wip { String::new() } else { relative_time(c.time, now) }).size(12).color(MUTED)).width(102),
        ]
        .align_y(iced::Alignment::Center)
        .height(ROW_H);
        let accent = if selected { Some(lane) } else { None };
        rows = rows.push(button(line).padding(0).on_press(Message::SelectCommit(i)).style(move |_, status| button::Style {
            background: Some(Background::Color(match (accent, status) {
                (Some(l), _) => Color { a: 0.14, ..l },
                (None, button::Status::Hovered) => ROW_HOVER,
                _ => Color::TRANSPARENT,
            })),
            border: Border { color: accent.unwrap_or(Color::TRANSPARENT), width: 0.0, radius: 0.0.into() },
            text_color: TEXT,
            ..Default::default()
        }));
    }
    rows = rows.push(Space::new().height((count - last) as f32 * ROW_H));
    rows.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_only_the_rows_in_view() {
        assert_eq!(visible(6000, 0.0, 340.0), (0, 15));
        assert_eq!(visible(6000, 3400.0, 340.0), (95, 115));
        assert_eq!(visible(10, 3400.0, 340.0), (10, 10));
    }
}
