// The right panel (RightPanel.tsx): the staging panel with the commit box while the uncommitted changes
// are selected, or the selected commit's details; and the diff's header bar (DiffView.tsx).
use gitline_core::format::{format_date, relative_time, split_path};
use gitline_core::session::FileList;
use gitline_core::view::file_counts;
use gitline_core::{CommitDetails, FileChange, FileStatus};
use iced::widget::{Space, button, checkbox, column, container, hover, pick_list, row, scrollable, text, text_editor, text_input};
use iced::{Alignment, Background, Color, Element, Length};

use crate::icons::Icon;
use crate::shell::{TOOLBAR_H, hline};
use crate::style::*;
use crate::{Lang, Message, Section};

/// `StatusIcon`: the file's change as an icon in its colour.
pub fn status_icon<'a>(s: FileStatus, size: f32) -> Element<'a, Message> {
    let (icon, color) = match s {
        FileStatus::Added | FileStatus::Untracked => (Icon::PLUS, GREEN),
        FileStatus::Deleted => (Icon::MINUS, RED),
        FileStatus::Renamed | FileStatus::Copied => (Icon::ARROW_RIGHT, BLUE),
        FileStatus::Conflicted => (Icon::TRIANGLE_ALERT, ORANGE),
        FileStatus::Modified | FileStatus::TypeChanged => (Icon::PENCIL, YELLOW),
    };
    icon.view(size, color).into()
}

fn xs<'a>(label: &'a str, style: fn(&iced::Theme, button::Status) -> button::Style, msg: Option<Message>) -> Element<'a, Message> {
    button(text(label).size(11)).padding([2, 8]).style(style).on_press_maybe(msg).into()
}

/// `.panel-header`: 48px, lined up with the toolbar.
fn panel_header<'a>(content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    column![
        container(content).height(TOOLBAR_H - 1.0).padding([6, 12]).align_y(Alignment::Center).width(Length::Fill).style(fill(BG_PANEL_2)),
        hline(BORDER_SOFT),
    ]
    .into()
}

/// `.file-row`: icon, folder (muted) and name, and an action shown on hover.
fn file_row<'a>(f: &'a FileChange, active: bool, open: Message, action: Option<Element<'a, Message>>) -> Element<'a, Message> {
    let (dir, name) = split_path(&f.path);
    let base = button(
        container(
            row![status_icon(f.status, 13.0), row![text(dir).color(MUTED), text(name).color(TEXT_STRONG)].width(Length::Fill)]
                .spacing(8)
                .align_y(Alignment::Center),
        )
        .padding(iced::Padding { left: 14.0, right: 10.0, top: 0.0, bottom: 0.0 })
        .height(26)
        .align_y(Alignment::Center)
        .clip(true),
    )
    .padding(0)
    .width(Length::Fill)
    .style(row_btn(active.then_some(BG_ACTIVE), BG_HOVER))
    .on_press(open);
    match action {
        Some(a) => hover(base, container(a).align_right(Length::Fill).padding([3, 10]).height(26)),
        None => base.into(),
    }
}

/// `.file-section`: a header with a count and an action, then its files.
fn file_section<'a>(title: String, action: Option<Element<'a, Message>>, body: Element<'a, Message>) -> Element<'a, Message> {
    let mut head = row![text(title).size(12).font(SANS_BOLD).width(Length::Fill)].align_y(Alignment::Center);
    if let Some(a) = action {
        head = head.push(a);
    }
    column![
        container(head).height(34).padding(iced::Padding { left: 12.0, right: 10.0, top: 0.0, bottom: 0.0 }).align_y(Alignment::Center),
        scrollable(body).height(Length::Fill).style(scrollbar),
        hline(BORDER_SOFT),
    ]
    .height(Length::FillPortion(1))
    .into()
}

pub struct StagingProps<'a> {
    pub branch: Option<&'a str>,
    pub unstaged: &'a [FileChange],
    pub staged: &'a [FileChange],
    pub active: Option<(FileList, usize)>,
    pub ignored: Option<&'a [String]>,
    pub ignored_open: bool,
    pub summary: &'a str,
    pub description: &'a text_editor::Content,
    pub amend: bool,
    pub can_commit: bool,
}

pub fn staging<'a>(p: StagingProps<'a>) -> Element<'a, Message> {
    let total = p.unstaged.len() + p.staged.len();
    let mut header = row![
        row![
            text(format!("{total} file change{} on ", if total == 1 { "" } else { "s" })),
            text(p.branch.unwrap_or("detached HEAD").to_string()).font(SANS_BOLD),
        ]
        .width(Length::Fill)
    ]
    .align_y(Alignment::Center);
    if total > 0 {
        header = header
            .push(button(Icon::TRASH.view(14.0, MUTED)).padding(3).style(icon_btn).on_press(Message::NotInSpike("Discarding all changes")));
    }
    let active = |list: FileList, i: usize| p.active == Some((list, i));
    let unstaged = column(p.unstaged.iter().enumerate().map(|(i, f)| {
        file_row(
            f,
            active(FileList::Unstaged, i),
            Message::OpenFile(FileList::Unstaged, i),
            Some(xs("Stage File", stage, Some(Message::StageFile(i)))),
        )
    }));
    let staged = column(p.staged.iter().enumerate().map(|(i, f)| {
        file_row(
            f,
            active(FileList::Staged, i),
            Message::OpenFile(FileList::Staged, i),
            Some(xs("Unstage File", unstage, Some(Message::UnstageFile(i)))),
        )
    }));

    let ignored_title = match (p.ignored_open, p.ignored) {
        (true, Some(list)) => format!("Ignored Files ({})", list.len()),
        _ => "Ignored Files".into(),
    };
    let chevron = if p.ignored_open { Icon::CHEVRON_DOWN } else { Icon::CHEVRON_RIGHT };
    let ignored_head = row![
        button(row![chevron.view(12.0, TEXT), text(ignored_title).size(12).font(SANS_BOLD)].spacing(4).align_y(Alignment::Center))
            .padding(0)
            .style(ghost(TEXT, TEXT, false))
            .on_press(Message::Toggle(Section("ignored".into()))),
        Space::new().width(Length::Fill),
        xs("Edit .gitignore", plain, Some(Message::NotInSpike("Editing .gitignore"))),
    ]
    .align_y(Alignment::Center);
    let ignored_body: Element<_> = match (p.ignored_open, p.ignored) {
        (false, _) => Space::new().into(),
        (true, None) => container(text("Loading…").size(12).color(MUTED))
            .padding(iced::Padding { top: 4.0, right: 12.0, bottom: 6.0, left: 26.0 })
            .into(),
        (true, Some([])) => container(text("Nothing is ignored").size(12).color(MUTED))
            .padding(iced::Padding { top: 4.0, right: 12.0, bottom: 6.0, left: 26.0 })
            .into(),
        (true, Some(list)) => column(list.iter().map(|f| {
            container(row![Icon::EYE_OFF.view(13.0, MUTED), text(f.clone()).color(MUTED)].spacing(8).align_y(Alignment::Center))
                .padding(iced::Padding { left: 14.0, right: 10.0, top: 0.0, bottom: 0.0 })
                .height(26)
                .align_y(Alignment::Center)
                .into()
        }))
        .into(),
    };
    let ignored = column![
        container(ignored_head)
            .height(34)
            .padding(iced::Padding { left: 12.0, right: 10.0, top: 0.0, bottom: 0.0 })
            .align_y(Alignment::Center),
        scrollable(ignored_body).height(Length::Fill).style(scrollbar),
    ]
    .height(Length::FillPortion(1));

    let n = p.staged.len();
    let label = if n == 0 && !p.amend {
        "Stage changes to commit".to_string()
    } else if p.amend {
        "Amend previous commit".into()
    } else {
        format!("Commit changes to {n} file{}", if n == 1 { "" } else { "s" })
    };
    let left = 72 - p.summary.chars().count() as i64;
    let summary = container(
        row![
            text_input("Summary", p.summary).on_input(Message::Summary).on_submit(Message::Commit).padding([6, 8]).style(bare_input),
            text(left.to_string()).size(11).color(if left < 0 { RED } else { MUTED }),
        ]
        .align_y(Alignment::Center)
        .padding(iced::Padding { right: 8.0, ..Default::default() }),
    )
    .style(boxed(BG_INPUT, BORDER));
    let commit_box = container(
        column![
            row![
                row![Icon::GIT_COMMIT_HORIZONTAL.view(14.0, TEXT), text("Commit").font(SANS_BOLD)]
                    .spacing(6)
                    .align_y(Alignment::Center)
                    .width(Length::Fill),
                button(Icon::USERS.view(14.0, MUTED)).padding(3).style(icon_btn).on_press(Message::NotInSpike("Adding co-authors")),
                checkbox(p.amend).label("Amend").on_toggle(Message::Amend).size(14).spacing(6).style(check),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
            summary,
            text_editor(p.description).placeholder("Description").on_action(Message::Description).height(90).padding([6, 8]).style(editor),
            button(container(text(label).font(SANS_BOLD)).center_x(Length::Fill))
                .padding(9)
                .width(Length::Fill)
                .style(commit)
                .on_press_maybe(p.can_commit.then_some(Message::Commit)),
        ]
        .spacing(8),
    )
    .padding(iced::Padding { top: 10.0, right: 12.0, bottom: 12.0, left: 12.0 })
    .style(fill(BG_PANEL_2));

    column![
        panel_header(header),
        file_section(
            format!("Unstaged Files ({})", p.unstaged.len()),
            (!p.unstaged.is_empty()).then(|| xs("Stage all changes", stage, Some(Message::StageAll))),
            unstaged.into(),
        ),
        file_section(
            format!("Staged Files ({n})"),
            (n > 0).then(|| xs("Unstage all changes", unstage, Some(Message::UnstageAll))),
            staged.into(),
        ),
        ignored,
        column![hline(BORDER_SOFT), commit_box],
    ]
    .into()
}

pub fn commit_panel<'a>(d: &'a CommitDetails, active: Option<usize>, now: i64) -> Element<'a, Message> {
    let mut parents = row![].spacing(10);
    for p in &d.parents {
        parents = parents.push(
            row![
                text("parent:").size(12).color(MUTED),
                button(text(p[..7.min(p.len())].to_string()).font(MONO).size(12))
                    .padding(0)
                    .style(ghost(ACCENT, ACCENT, false))
                    .on_press(Message::JumpTo(p.clone())),
            ]
            .spacing(4)
            .align_y(Alignment::Center),
        );
    }
    let header = row![
        row![
            text("commit:").color(MUTED),
            text(d.sha[..7.min(d.sha.len())].to_string()).font(MONO).color(TEXT_STRONG),
            button(Icon::COPY.view(12.0, MUTED)).padding(3).style(icon_btn).on_press(Message::CopySha(d.sha.clone())),
        ]
        .spacing(6)
        .align_y(Alignment::Center)
        .width(Length::Fill),
        parents,
    ]
    .align_y(Alignment::Center);

    let (subject, body) = d.message.split_once('\n').map_or((d.message.as_str(), ""), |(s, b)| (s, b.trim()));
    let mut message = column![text(subject).size(15).font(SANS_BOLD).color(TEXT_STRONG)];
    if !body.is_empty() {
        message = message.push(
            container(scrollable(text(body)).style(scrollbar)).max_height(220).padding(iced::Padding { top: 8.0, ..Default::default() }),
        );
    }

    let mut who = column![
        row![text(d.author.clone()).size(12).font(SANS_BOLD).color(TEXT_STRONG), text(format!("<{}>", d.email)).size(12).color(MUTED)]
            .spacing(4),
        text(format!("authored {} ({})", format_date(d.time), relative_time(d.time, now))).size(12).color(MUTED),
    ];
    if d.committer != d.author || d.commit_time != d.time {
        who = who.push(text(format!("committed by {} · {}", d.committer, format_date(d.commit_time))).size(12).color(MUTED));
    }
    let author = row![crate::graph::avatar(&d.author, &d.email, 30.0, 12.6), who].spacing(10).align_y(Alignment::Center);

    let c = file_counts(&d.files);
    let mut summary = row![].spacing(12).align_y(Alignment::Center);
    for (n, icon, color, word) in [
        (c.modified, Icon::PENCIL, YELLOW, "modified"),
        (c.added, Icon::PLUS, GREEN, "added"),
        (c.deleted, Icon::MINUS, RED, "deleted"),
        (c.renamed, Icon::ARROW_RIGHT, BLUE, "renamed"),
    ] {
        if n > 0 {
            summary = summary.push(
                row![icon.view(12.0, color), text(format!("{n} {word}")).size(12).color(color)].spacing(4).align_y(Alignment::Center),
            );
        }
    }
    if d.parents.len() > 1 {
        summary = summary.push(text("(changes vs. first parent)").size(12).color(MUTED));
    }

    let files =
        column(d.files.iter().enumerate().map(|(i, f)| file_row(f, active == Some(i), Message::OpenFile(FileList::Commit, i), None)));
    column![
        panel_header(header),
        container(message).padding(12).width(Length::Fill),
        hline(BORDER_SOFT),
        container(author).padding([10, 12]).width(Length::Fill),
        hline(BORDER_SOFT),
        container(summary).padding([8, 12]),
        hline(BORDER_SOFT),
        scrollable(files).height(Length::Fill).style(scrollbar),
    ]
    .into()
}

pub struct DiffHeaderProps<'a> {
    pub file: &'a FileChange,
    pub added: usize,
    pub removed: usize,
    pub binary: bool,
    /// Some(staged) for an uncommitted file's diff.
    pub wip: Option<bool>,
    pub language: Option<&'a str>,
    pub plain: bool,
    pub ignore_ws: bool,
    /// The header's width, for wrapping its buttons.
    pub width: f32,
}

/// Roughly how wide 12px IBM Plex Sans text is (for wrapping; iced lays rows out without flex-wrap's
/// per-item measuring).
fn text_w(s: &str) -> f32 {
    s.chars().count() as f32 * 6.1
}

/// `.diff-header`: the file's status and counts on the left, its tools on the right; tools that don't
/// fit wrap onto further lines, one at a time, as with `flex-wrap`.
pub fn diff_header<'a>(p: DiffHeaderProps<'a>) -> Element<'a, Message> {
    const GAP: f32 = 8.0;
    let sm = |label: &'a str, style: fn(&iced::Theme, button::Status) -> button::Style, msg: Message| -> (Element<'a, Message>, f32) {
        (button(text(label).size(12)).padding([4, 10]).style(style).on_press(msg).into(), text_w(label) + 22.0)
    };
    let mut items: Vec<Element<_>> = vec![status_icon(p.file.status, 14.0)];
    let mut left_w = 14.0;
    if let Some(old) = p.file.old_path.as_ref().filter(|o| **o != p.file.path) {
        let t = format!("renamed from {old}");
        left_w += GAP + text_w(&t);
        items.push(text(t).size(12).color(MUTED).into());
    }
    if !p.binary {
        let (a, r) = (format!("+{}", p.added), format!("−{}", p.removed));
        left_w += GAP + (a.chars().count() + r.chars().count()) as f32 * 7.2 + GAP;
        items.push(row![text(a).font(MONO).size(12).color(GREEN), text(r).font(MONO).size(12).color(RED)].spacing(8).into());
    }
    if let Some(staged) = p.wip {
        let (bg, fg, label) = if staged { (alpha(GREEN, 0.25), GREEN_TEXT, "STAGED") } else { (alpha(YELLOW, 0.22), YELLOW, "UNSTAGED") };
        left_w += GAP + label.len() as f32 * 6.0 + 12.0;
        items.push(
            container(text(label).size(10).font(SANS_BOLD).color(fg))
                .padding([2, 6])
                .style(move |_| container::Style {
                    background: Some(Background::Color(bg)),
                    border: border(Color::TRANSPARENT),
                    ..Default::default()
                })
                .into(),
        );
    }

    let mut tools: Vec<(Element<_>, f32)> = Vec::new();
    if !p.binary {
        // Files with no known language are just "Plain text".
        let auto = p.language.map(|l| Lang::Auto(l.to_string()));
        let options: Vec<Lang> = std::iter::once(Lang::Plain).chain(auto.clone()).collect();
        let selected = match auto {
            Some(a) if !p.plain => a,
            _ => Lang::Plain,
        };
        tools.push((
            pick_list(options, Some(selected), |l| Message::SetPlain(l == Lang::Plain))
                .width(150)
                .text_size(13)
                .padding([5, 8])
                .style(select)
                .menu_style(menu)
                .into(),
            150.0,
        ));
    }
    tools.push((
        button(text("Ignore whitespace").size(12))
            .padding([4, 10])
            .style(move |t, s| toggle(p.ignore_ws)(t, s))
            .on_press(Message::ToggleIgnoreWs)
            .into(),
        text_w("Ignore whitespace") + 22.0,
    ));
    tools.push((
        container(row![
            button(Icon::ROWS_3.view(14.0, TEXT_STRONG)).padding([4, 8]).style(|t, s| seg(true)(t, s)),
            button(Icon::COLUMNS_2.view(14.0, MUTED))
                .padding([4, 8])
                .style(|t, s| seg(false)(t, s))
                .on_press(Message::NotInSpike("The split view")),
        ])
        .style(|_| container::Style { border: border(BORDER), ..Default::default() })
        .into(),
        62.0,
    ));
    let deleted = p.file.status == FileStatus::Deleted;
    let new = matches!(p.file.status, FileStatus::Untracked | FileStatus::Added);
    if !new {
        tools.push(sm("History", plain, Message::NotInSpike("File history")));
    }
    if !deleted && !(new && p.wip.is_some()) {
        tools.push(sm("Blame", plain, Message::NotInSpike("Blame")));
    }
    match p.wip {
        Some(false) => {
            if p.file.status != FileStatus::Conflicted {
                tools.push(sm("Discard File", danger_ghost, Message::NotInSpike("Discarding a file")));
            }
            tools.push(sm("Stage File", stage, Message::ToggleFile));
        }
        Some(true) => tools.push(sm("Unstage File", unstage, Message::ToggleFile)),
        None => {}
    }

    // The first line takes the left group and as many tools as fit (pushed right by the spacer); the
    // rest fill further lines from the left.
    let avail = p.width - 24.0;
    let mut used = left_w;
    let mut first: Vec<Element<_>> = Vec::new();
    let mut lines: Vec<Vec<Element<_>>> = Vec::new();
    let mut line_w = 0.0;
    for (el, w) in tools {
        if lines.is_empty() && used + GAP * 2.0 + w <= avail {
            used += GAP + w;
            first.push(el);
            continue;
        }
        if lines.is_empty() || line_w + GAP + w > avail {
            lines.push(Vec::new());
            line_w = 0.0;
        }
        line_w += if line_w == 0.0 { w } else { GAP + w };
        lines.last_mut().unwrap().push(el);
    }
    let mut col = column![
        row![
            row(items).spacing(GAP).align_y(Alignment::Center),
            Space::new().width(Length::Fill),
            row(first).spacing(GAP).align_y(Alignment::Center)
        ]
        .spacing(GAP)
        .align_y(Alignment::Center)
    ]
    .spacing(6);
    for l in lines {
        col = col.push(row(l).spacing(GAP).align_y(Alignment::Center));
    }
    column![
        container(col).padding(iced::Padding { top: 6.0, right: 10.0, bottom: 6.0, left: 14.0 }).width(Length::Fill).style(fill(BG_PANEL)),
        hline(DIVIDER),
    ]
    .into()
}
