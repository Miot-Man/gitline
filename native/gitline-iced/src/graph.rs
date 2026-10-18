// The history list, laid out like src/components/CommitGraph.tsx: the lanes, then branch/tag pills and
// the subject, then author and date when the list is wide enough. Only the rows in view are built (the
// list scrolls over a spacer of the full height), and each row's lanes are drawn on a small canvas.
use gitline_core::format::{author_color, initials};
use gitline_core::view::{GraphCell, History, NodeKind, Pill, ROW_H};
use gitline_core::{RefType, WIP};
use iced::widget::canvas::{self, Frame, Geometry, LineCap, LineDash, LineJoin, Path, Stroke};
use iced::widget::{Space, button, canvas as canvas_widget, column, container, row, stack, text};
use iced::{Alignment, Background, Border, Color, Element, Font, Length, Point, Rectangle, Renderer, Theme, mouse};

use crate::Message;
use crate::icons::Icon;
use crate::style::*;

/// At most this many pills per row; the rest collapse into "+N".
const MAX_PILLS: usize = 2;
/// Below these list widths the date, then the author column is hidden (the CSS container queries).
const DATE_MIN_W: f32 = 900.0;
const AUTHOR_MIN_W: f32 = 700.0;

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
        let ring = |frame: &mut Frame, r: f32, stroke: Stroke| {
            let circle = Path::circle(c, r);
            frame.fill(&circle, BG_GRAPH);
            frame.stroke(&circle, stroke);
        };
        match cell.node {
            NodeKind::Wip => ring(
                &mut frame,
                5.0,
                Stroke { line_dash: LineDash { segments: &[2.5, 2.0], offset: 0 }, ..Stroke::default().with_width(2.0).with_color(ORANGE) },
            ),
            NodeKind::Head => {
                frame.stroke(&Path::circle(c, 8.5), Stroke::default().with_width(2.5).with_color(alpha(color, 0.35)));
                frame.fill(&Path::circle(c, 5.5), color);
            }
            NodeKind::Merge => {
                ring(&mut frame, 5.5, Stroke::default().with_width(2.5).with_color(color));
                frame.fill(&Path::circle(c, 2.0), color);
            }
            NodeKind::Commit => ring(&mut frame, 5.0, Stroke::default().with_width(2.5).with_color(color)),
        }
        vec![frame.into_geometry()]
    }
}

/// `.ref-pill`: tinted in the lane's colour; filled for the checked-out branch; outlined for tags.
fn pill(p: Pill, tag: Color) -> Element<'static, Message> {
    let is_tag = p.kind == RefType::Tag;
    let (bg, line, fg) = match (is_tag, p.is_head) {
        (true, _) => (Color::TRANSPARENT, MUTED, TEXT),
        (_, true) => (tag, tag, BG),
        _ => (alpha(tag, 0.14), alpha(tag, 0.45), tag),
    };
    let mut r = row![].spacing(4).align_y(Alignment::Center);
    if p.is_head && p.kind == RefType::Local {
        r = r.push(Icon::CHECK.view(11.0, fg));
    }
    if is_tag {
        r = r.push(Icon::TAG.view(11.0, fg));
    }
    let font = if p.is_head { Font { weight: iced::font::Weight::Medium, ..MONO } } else { MONO };
    r = r.push(text(p.label).font(font).size(11).color(fg).wrapping(text::Wrapping::None));
    if p.kind == RefType::Local && p.on_remote {
        r = r.push(Icon::CLOUD.view(11.0, fg));
    }
    container(r)
        .padding([0, 6])
        .height(18)
        .max_width(220)
        .align_y(Alignment::Center)
        .clip(true)
        .style(move |_| container::Style { background: Some(Background::Color(bg)), border: border(line), ..Default::default() })
        .into()
}

/// `.avatar`: the author's initials on their colour.
pub fn avatar(name: &str, email: &str, size: f32, text_size: f32) -> Element<'static, Message> {
    let bg = hex(author_color(email));
    container(text(initials(name)).size(text_size).font(SANS_BOLD).color(WHITE))
        .center_x(size)
        .center_y(size)
        .style(move |_| container::Style {
            background: Some(Background::Color(bg)),
            border: Border { radius: (size / 2.0).into(), ..Border::default() },
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
    /// "3 uncommitted changes" and "· a.rs, b.rs".
    pub wip: (String, String),
    /// Width of the list, which decides the author and date columns.
    pub width: f32,
    /// Scroll offset and height of the list's viewport.
    pub offset: f32,
    pub height: f32,
    pub now: i64,
    /// Adds a "Load more commits" button after the last row.
    pub can_load_more: bool,
}

/// Rows `[first, last)` that are (nearly) in view.
pub fn visible(count: usize, offset: f32, height: f32) -> (usize, usize) {
    let first = ((offset / ROW_H).floor().max(0.0) as usize).saturating_sub(8).min(count);
    let last = (((offset + height) / ROW_H).ceil() as usize + 8).min(count);
    (first, last.max(first))
}

/// `.graph-header`: column titles above the list.
pub fn header<'a>(graph_width: f32, width: f32) -> Element<'a, Message> {
    let title = |s: &'a str| text(s).size(11).font(SANS_MEDIUM).color(MUTED);
    let mut r =
        row![Space::new().width(graph_width), container(title("Commit")).padding([0, 10]).width(Length::Fill)].align_y(Alignment::Center);
    if width >= AUTHOR_MIN_W {
        r = r.push(container(title("Author")).padding([0, 10]).width(150));
    }
    if width >= DATE_MIN_W {
        r = r.push(container(title("Date")).padding([0, 14]).align_right(110));
    }
    column![
        container(r).height(29).align_y(Alignment::Center).width(Length::Fill).style(fill(BG_PANEL)),
        container(Space::new()).height(1).width(Length::Fill).style(fill(BORDER_SOFT)),
    ]
    .into()
}

pub fn view<'a>(p: GraphProps<'a>) -> Element<'a, Message> {
    let count = p.history.commits.len();
    let (first, last) = visible(count, p.offset, p.height);
    let show_author = p.width >= AUTHOR_MIN_W;
    let show_date = p.width >= DATE_MIN_W;
    let mut rows = column![Space::new().height(first as f32 * ROW_H)];
    for i in first..last {
        let c = &p.history.commits[i];
        let cell = p.history.cell(i, p.head);
        let lane = hex(cell.node_color);
        let selected = i == p.selected;
        let wip = c.sha == WIP;

        let mut msg = row![].spacing(6).align_y(Alignment::Center);
        if wip {
            msg = msg
                .push(text(p.wip.0.clone()).color(ORANGE).wrapping(text::Wrapping::None))
                .push(container(text(p.wip.1.clone()).color(MUTED).wrapping(text::Wrapping::None)).padding([0, 4]));
        } else {
            let pills = p.history.pills(i, p.head, p.detached);
            let more = pills.len().saturating_sub(MAX_PILLS);
            for x in pills.into_iter().take(MAX_PILLS) {
                msg = msg.push(pill(x, lane));
            }
            if more > 0 {
                msg = msg.push(
                    container(text(format!("+{more}")).font(MONO).size(10).color(MUTED))
                        .padding([0, 5])
                        .height(18)
                        .align_y(Alignment::Center)
                        .style(|_| container::Style { border: border(BORDER), ..Default::default() }),
                );
            }
            msg = msg.push(text(c.subject.clone()).color(if selected { TEXT_STRONG } else { TEXT }).wrapping(text::Wrapping::None));
        }

        let mut line = row![
            canvas_widget(CellView(cell)).width(p.graph_width).height(ROW_H),
            container(msg).padding([0, 10]).width(Length::Fill).height(ROW_H).align_y(Alignment::Center).clip(true),
        ];
        if show_author {
            let author: Element<_> = if wip {
                Space::new().into()
            } else {
                row![avatar(&c.author, &c.email, 18.0, 8.0), text(c.author.clone()).color(MUTED).wrapping(text::Wrapping::None)]
                    .spacing(7)
                    .align_y(Alignment::Center)
                    .into()
            };
            line = line.push(container(author).padding([0, 10]).width(150).height(ROW_H).align_y(Alignment::Center).clip(true));
        }
        if show_date {
            let day = p.history.day(i, p.now).unwrap_or_default();
            line = line.push(container(text(day).size(12)).padding([0, 14]).align_right(110).height(ROW_H).align_y(Alignment::Center));
        }

        let row_bg = selected.then_some(alpha(lane, 0.14));
        let body = button(line).padding(0).width(Length::Fill).on_press(Message::SelectCommit(i)).style(row_btn(row_bg, ROW_HOVER));
        // `.graph-row.selected`: an inset 2px bar in the lane's colour.
        let item: Element<_> =
            if selected { stack![body, container(Space::new()).width(2).height(ROW_H).style(fill(lane))].into() } else { body.into() };
        rows = rows.push(item);
    }
    rows = rows.push(Space::new().height((count - last) as f32 * ROW_H));
    if p.can_load_more {
        let more = button(text("Load more commits").size(12)).padding([4, 10]).style(plain).on_press(Message::LoadMore);
        rows = rows.push(container(more).center_x(Length::Fill).center_y(ROW_H * 2.0));
    }
    rows.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_only_the_rows_in_view() {
        assert_eq!(visible(6000, 0.0, 340.0), (0, 18));
        assert_eq!(visible(6000, 3400.0, 340.0), (92, 118));
        assert_eq!(visible(10, 3400.0, 340.0), (10, 10));
    }
}
