// The app's frame around the history: the rail of icons (Rail.tsx), the branches sidebar (Sidebar.tsx),
// the toolbar above the graph (Toolbar.tsx), the status bar (StatusBar.tsx) and toasts.
use std::collections::{BTreeMap, HashMap, HashSet};

use gitline_core::format::relative_time;
use gitline_core::{Ref, RefType, Stash};
use iced::widget::{Space, button, column, container, row, text, text_input};
use iced::{Alignment, Background, Border, Color, Element, Length};

use crate::icons::Icon;
use crate::style::*;
use crate::{Message, Section, ToastKind};

pub const RAIL_W: f32 = 52.0;
pub const TOOLBAR_H: f32 = 48.0;

/// A 1px line: `border-*: 1px solid color`.
pub fn hline<'a>(color: Color) -> Element<'a, Message> {
    container(Space::new()).height(1).width(Length::Fill).style(fill(color)).into()
}

pub fn vline<'a>(color: Color) -> Element<'a, Message> {
    container(Space::new()).width(1).height(Length::Fill).style(fill(color)).into()
}

/// `.splitter`: a 2px divider line. (In the Electron app the 4px splitter overlaps the panels on
/// both sides, so only its line takes room.)
pub fn splitter<'a>() -> Element<'a, Message> {
    container(Space::new()).width(2).height(Length::Fill).style(fill(DIVIDER)).into()
}

// ---- rail ----

/// Two letters for a repo tile: initials of the first two words, else the first two letters.
pub fn repo_initials(name: &str) -> String {
    let words: Vec<&str> = name.split(['-', '_', '.', ' ']).filter(|w| !w.is_empty()).collect();
    match words.as_slice() {
        [a, b, ..] => format!("{}{}", a.chars().next().unwrap(), b.chars().next().unwrap()).to_uppercase(),
        [a] => a.chars().take(2).collect::<String>().to_uppercase(),
        [] => "?".into(),
    }
}

fn rail_item<'a>(icon: Icon, active: bool, badge: Option<usize>, msg: Message) -> Element<'a, Message> {
    let b = button(container(icon.view(18.0, if active { TEXT_STRONG } else { MUTED })).center_x(40).center_y(38))
        .padding(0)
        .style(crate::style::rail_btn(active))
        .on_press(msg);
    let mut layers = iced::widget::stack![b];
    if active {
        // `box-shadow: inset 2px 0 0 var(--accent)`
        layers = layers.push(container(Space::new()).width(2).height(38).style(fill(ACCENT)));
    }
    if let Some(n) = badge.filter(|n| *n > 0) {
        let dot = container(text(n.to_string()).size(9).font(SANS_BOLD).color(BG))
            .padding([0, 3])
            .height(14)
            .width(Length::Shrink)
            .center_y(14)
            .style(|_| container::Style {
                background: Some(Background::Color(ORANGE)),
                border: Border { radius: 7.0.into(), ..Border::default() },
                ..Default::default()
            });
        layers = layers.push(container(dot).width(40).padding([3, 3]).align_right(40));
    }
    layers.into()
}

fn sep<'a>() -> Element<'a, Message> {
    container(container(Space::new()).width(24).height(1).style(fill(BORDER_SOFT))).padding([6, 0]).into()
}

pub fn rail<'a>(repo_name: &str, changes: usize, history_active: bool) -> Element<'a, Message> {
    let tile = |label: Element<'a, Message>, active: bool, msg: Message| -> Element<'a, Message> {
        button(container(label).center_x(32).center_y(32)).padding(0).width(34).height(34).style(rail_tile(active)).on_press(msg).into()
    };
    let add = button(container(Icon::PLUS.view(14.0, MUTED)).center_x(32).center_y(32))
        .padding(0)
        .width(34)
        .height(34)
        .style(|_, s| {
            // `.rail-tile.add` has a dashed border; iced draws it solid.
            let mut st = rail_tile(false)(&iced::Theme::Dark, s);
            st.border.color = BORDER;
            st
        })
        .on_press(Message::NotInSpike("Opening another repository"));
    let content = column![
        tile(text(repo_initials(repo_name)).size(12).font(SANS_BOLD).into(), true, Message::NotInSpike("Repository tabs")),
        Space::new().height(2),
        add,
        sep(),
        rail_item(Icon::WAYPOINTS, history_active, None, Message::ShowHistory),
        rail_item(Icon::FILE_DIFF, !history_active, Some(changes), Message::ShowChanges),
        rail_item(Icon::GIT_PULL_REQUEST, false, None, Message::NotInSpike("Pull requests")),
        rail_item(Icon::SEARCH, false, None, Message::NotInSpike("Search and commands")),
        Space::new().height(Length::Fill),
        rail_item(Icon::CODE_XML, false, None, Message::NotInSpike("Open in editor")),
        rail_item(Icon::SQUARE_TERMINAL, false, None, Message::NotInSpike("Open terminal")),
        rail_item(Icon::FOLDER_OPEN, false, None, Message::NotInSpike("Show in folder")),
        sep(),
        rail_item(Icon::SETTINGS, false, None, Message::NotInSpike("Settings")),
    ]
    .spacing(4)
    .align_x(Alignment::Center)
    .padding([10, 0]);
    row![container(content).width(RAIL_W - 1.0).align_x(Alignment::Center).height(Length::Fill).style(fill(BG_TABBAR)), vline(BORDER_SOFT)]
        .into()
}

// ---- sidebar ----

pub struct SidebarProps<'a> {
    pub refs: &'a [Ref],
    pub remotes: &'a [String],
    pub stashes: &'a [Stash],
    pub filter: &'a str,
    pub collapsed: &'a HashSet<String>,
    pub lane_colors: &'a HashMap<String, u32>,
}

/// A branch tree: folders for `a/b` names, refs as leaves.
#[derive(Default)]
struct Tree<'a> {
    children: BTreeMap<String, Tree<'a>>,
    leaf: Option<&'a Ref>,
}

fn tree<'a>(refs: impl Iterator<Item = &'a Ref>, strip: usize) -> Tree<'a> {
    let mut root = Tree::default();
    for r in refs {
        let parts: Vec<&str> = r.name.split('/').skip(strip).collect();
        let mut node = &mut root;
        for (i, part) in parts.iter().enumerate() {
            let key = if i + 1 == parts.len() { part.to_string() } else { format!("{part}/") };
            node = node.children.entry(key).or_default();
        }
        node.leaf = Some(r);
    }
    root
}

/// `ahead 1, behind 2` -> (1, 2)
fn track(t: Option<&str>) -> (u32, u32) {
    let mut out = (0, 0);
    for part in t.unwrap_or("").split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            out.0 = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            out.1 = n.parse().unwrap_or(0);
        }
    }
    out
}

fn side_item<'a>(content: impl Into<Element<'a, Message>>, indent: f32, msg: Message) -> Element<'a, Message> {
    button(
        container(content)
            .padding(iced::Padding { left: indent, right: 10.0, top: 0.0, bottom: 0.0 })
            .height(26)
            .align_y(Alignment::Center),
    )
    .padding(0)
    .width(Length::Fill)
    .style(row_btn(None, BG_HOVER))
    .on_press(msg)
    .into()
}

fn ref_row<'a>(r: &'a Ref, depth: usize, remote: bool, lanes: &HashMap<String, u32>) -> Element<'a, Message> {
    let lane = lanes.get(&r.sha).map(|c| hex(*c));
    let icon: Element<_> = if remote {
        Icon::CLOUD.view(13.0, lane.unwrap_or(MUTED)).into()
    } else {
        // `.lane-dot`: a ring in the lane's colour, filled (with a halo) for the checked-out branch.
        let c = lane.unwrap_or(MUTED);
        let ring = container(Space::new()).width(10).height(10).style(move |_| container::Style {
            background: r.is_head.then_some(Background::Color(c)),
            border: Border { color: c, width: 2.5, radius: 5.0.into() },
            ..Default::default()
        });
        container(ring).padding([0, 2]).into()
    };
    let label = r.name.rsplit('/').next().unwrap_or(&r.name).to_string();
    let mut line = row![
        icon,
        text(label)
            .font(if r.is_head { SANS_BOLD } else { SANS })
            .color(if r.is_head { TEXT_STRONG } else { TEXT })
            .width(Length::Fill)
            .wrapping(text::Wrapping::None)
    ]
    .spacing(6)
    .align_y(Alignment::Center);
    let (ahead, behind) = track(r.track.as_deref());
    if behind > 0 {
        line =
            line.push(row![text(behind.to_string()).size(11).color(MUTED), Icon::ARROW_DOWN.view(10.0, MUTED)].align_y(Alignment::Center));
    }
    if ahead > 0 {
        line = line.push(row![text(ahead.to_string()).size(11).color(MUTED), Icon::ARROW_UP.view(10.0, MUTED)].align_y(Alignment::Center));
    }
    side_item(line, 24.0 + depth as f32 * 14.0, Message::JumpTo(r.sha.clone()))
}

fn render_tree<'a>(node: &Tree<'a>, depth: usize, key: &str, remote: bool, p: &SidebarProps<'a>, out: &mut Vec<Element<'a, Message>>) {
    // Folders first, then refs, each by name.
    let mut kids: Vec<(&String, &Tree<'a>)> = node.children.iter().collect();
    kids.sort_by_key(|(name, t)| (t.leaf.is_some() && t.children.is_empty(), name.to_lowercase()));
    for (name, child) in kids {
        if let (Some(r), true) = (child.leaf, child.children.is_empty()) {
            out.push(ref_row(r, depth, remote, p.lane_colors));
            continue;
        }
        let k = format!("{key}/{name}");
        let open = !p.collapsed.contains(&k) || !p.filter.is_empty();
        let chevron = if open { Icon::CHEVRON_DOWN } else { Icon::CHEVRON_RIGHT };
        out.push(side_item(
            row![chevron.view(12.0, MUTED), Icon::FOLDER.view(13.0, MUTED), text(name.trim_end_matches('/').to_string()).color(MUTED)]
                .spacing(6)
                .align_y(Alignment::Center),
            10.0 + depth as f32 * 14.0,
            Message::Toggle(Section(k.clone())),
        ));
        if open {
            render_tree(child, depth + 1, key, remote, p, out);
        }
        if let Some(r) = child.leaf {
            out.push(ref_row(r, depth + 1, remote, p.lane_colors));
        }
    }
}

fn section<'a>(
    key: &str,
    title: &'static str,
    count: usize,
    collapsed: &HashSet<String>,
    action: Option<(Icon, &'static str)>,
    body: Vec<Element<'a, Message>>,
) -> Element<'a, Message> {
    let open = !collapsed.contains(key);
    let chevron = if open { Icon::CHEVRON_DOWN } else { Icon::CHEVRON_RIGHT };
    let mut head = row![
        chevron.view(13.0, MUTED),
        text(title).size(12).font(SANS_MEDIUM).color(MUTED),
        text(count.to_string()).font(MONO).size(11).color(SCROLLBAR_HOVER),
        Space::new().width(Length::Fill),
    ]
    .spacing(5)
    .align_y(Alignment::Center);
    if let Some((icon, what)) = action {
        head = head.push(button(icon.view(13.0, MUTED)).padding(3).style(icon_btn).on_press(Message::NotInSpike(what)));
    }
    let header = button(container(head).height(30).padding([0, 8]).align_y(Alignment::Center))
        .padding(0)
        .width(Length::Fill)
        .style(ghost(MUTED, TEXT, false))
        .on_press(Message::Toggle(Section(key.to_string())));
    let mut col = column![header];
    if open {
        col = col.extend(body);
    }
    container(col).padding(iced::Padding { bottom: 2.0, ..Default::default() }).into()
}

/// The sidebar's sections, for the caller to put in its (smooth) scrollable.
pub fn sidebar_body<'a>(p: &SidebarProps<'a>) -> Element<'a, Message> {
    let f = p.filter.trim().to_lowercase();
    let matches = |r: &&Ref| f.is_empty() || r.name.to_lowercase().contains(&f);
    let locals: Vec<&Ref> = p.refs.iter().filter(|r| r.kind == RefType::Local).collect();
    let tags: Vec<&Ref> = p.refs.iter().filter(|r| r.kind == RefType::Tag).collect();

    let mut branches = Vec::new();
    render_tree(&tree(locals.iter().copied().filter(matches), 0), 0, "local", false, p, &mut branches);

    let mut remotes = Vec::new();
    for remote in p.remotes {
        let key = format!("remote:{remote}");
        let open = !p.collapsed.contains(&key) || !f.is_empty();
        let chevron = if open { Icon::CHEVRON_DOWN } else { Icon::CHEVRON_RIGHT };
        remotes.push(side_item(
            row![chevron.view(12.0, MUTED), Icon::CLOUD.view(13.0, MUTED), text(remote.clone()).color(MUTED)]
                .spacing(6)
                .align_y(Alignment::Center),
            10.0,
            Message::Toggle(Section(key.clone())),
        ));
        if open {
            let mine = p.refs.iter().filter(|r| r.kind == RefType::Remote && r.remote.as_deref() == Some(remote.as_str())).filter(matches);
            render_tree(&tree(mine, 1), 1, &key, true, p, &mut remotes);
        }
    }

    let stashes: Vec<Element<_>> = p
        .stashes
        .iter()
        .filter(|s| f.is_empty() || s.message.to_lowercase().contains(&f))
        .map(|s| {
            side_item(
                row![Icon::ARCHIVE.view(13.0, MUTED), text(s.message.clone()).wrapping(text::Wrapping::None)]
                    .spacing(6)
                    .align_y(Alignment::Center),
                24.0,
                Message::NotInSpike("Showing a stash"),
            )
        })
        .collect();

    let tag_rows: Vec<Element<_>> = tags
        .iter()
        .copied()
        .filter(matches)
        .map(|t| {
            side_item(
                row![Icon::TAG.view(13.0, MUTED), text(t.name.clone()).wrapping(text::Wrapping::None)]
                    .spacing(6)
                    .align_y(Alignment::Center),
                24.0,
                Message::JumpTo(t.sha.clone()),
            )
        })
        .collect();

    column![
        section("local", "Branches", locals.len(), p.collapsed, Some((Icon::PLUS, "Creating a branch")), branches),
        section("remote", "Remotes", p.remotes.len(), p.collapsed, Some((Icon::PLUS, "Adding a remote")), remotes),
        section("stashes", "Stashes", p.stashes.len(), p.collapsed, None, stashes),
        section("tags", "Tags", tags.len(), p.collapsed, None, tag_rows),
        Space::new().height(20),
    ]
    .into()
}

/// `.side-title` (the repo name) and `.side-filter`.
pub fn sidebar_top<'a>(repo_name: String, filter: &str) -> Element<'a, Message> {
    let title = button(
        row![text(repo_name).font(SANS_BOLD).color(TEXT_STRONG), Icon::CHEVRON_DOWN.view(14.0, MUTED)]
            .spacing(6)
            .align_y(Alignment::Center),
    )
    .padding([5, 6])
    .style(ghost(TEXT_STRONG, TEXT_STRONG, true))
    .on_press(Message::NotInSpike("Switching repositories"));
    let filter_box = container(
        row![
            Icon::SEARCH.view(13.0, MUTED),
            text_input("Filter (branches, tags, stashes)", filter).on_input(Message::SidebarFilter).padding([6, 0]).style(bare_input),
        ]
        .spacing(6)
        .align_y(Alignment::Center),
    )
    .padding([0, 8])
    .style(boxed(BG_INPUT, BORDER));
    column![
        container(title).height(TOOLBAR_H - 1.0).padding([0, 8]).align_y(Alignment::Center).width(Length::Fill).style(fill(BG_TOOLBAR)),
        hline(DIVIDER),
        container(filter_box).padding(8),
    ]
    .into()
}

// ---- toolbar ----

/// A breadcrumb: (label, monospace, what clicking it does).
pub type Crumb = (String, bool, Option<Message>);

/// `.tool-btn:disabled` is at 40% opacity.
fn tool_fg(enabled: bool) -> Color {
    if enabled { TEXT } else { mix(TEXT, BG_TOOLBAR, 0.4) }
}

fn tool_btn<'a>(icon: Icon, label: &'a str, show_label: bool, what: &'static str, enabled: bool) -> Element<'a, Message> {
    let fg = tool_fg(enabled);
    let mut r = row![icon.view(15.0, fg)].spacing(6).align_y(Alignment::Center);
    if show_label {
        r = r.push(text(label).size(12).color(fg));
    }
    let b = button(container(r).height(28).align_y(Alignment::Center))
        .padding(if show_label { [0, 10] } else { [0, 8] })
        .style(crate::style::tool_btn);
    b.on_press_maybe(enabled.then_some(Message::NotInSpike(what))).into()
}

fn icon_only<'a>(icon: Icon, enabled: bool, what: &'static str) -> Element<'a, Message> {
    let fg = tool_fg(enabled);
    button(container(icon.view(15.0, fg)).center_x(30).center_y(28))
        .padding(0)
        .style(crate::style::tool_btn)
        .on_press_maybe(enabled.then_some(Message::NotInSpike(what)))
        .into()
}

/// `.tool-group`: buttons in one bordered box, divided by 1px lines.
fn group<'a>(items: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let mut r = row![];
    for (i, item) in items.into_iter().enumerate() {
        if i > 0 {
            r = r.push(container(Space::new()).width(1).height(28).style(fill(BORDER)));
        }
        r = r.push(item);
    }
    container(r).style(|_| container::Style { border: border(BORDER), ..Default::default() }).into()
}

/// The toolbar above the graph: "History / branch", or a breadcrumb trail with a back button while a
/// diff is open; and the Undo/Redo, Fetch/Pull/Push and Branch/Stash/Pop groups, which drop their
/// labels and then whole groups as the toolbar narrows (the CSS container queries).
pub fn toolbar<'a>(branch: Option<&str>, trail: Option<Vec<Crumb>>, width: f32, can_pop: bool) -> Element<'a, Message> {
    let left: Element<_> = match trail {
        Some(crumbs) => {
            let mut r = row![
                button(container(Icon::CHEVRON_LEFT.view(15.0, TEXT)).center_x(26).center_y(26))
                    .padding(0)
                    .style(back)
                    .on_press(Message::CloseDiff)
            ]
            .spacing(8)
            .align_y(Alignment::Center);
            let mut trail = row![].spacing(6).align_y(Alignment::Center);
            for (i, (label, mono, msg)) in crumbs.into_iter().enumerate() {
                if i > 0 {
                    trail = trail.push(text("›").color(SCROLLBAR_HOVER));
                }
                let t = text(label).font(if mono { MONO } else { SANS }).size(if mono { 12 } else { 13 }).wrapping(text::Wrapping::None);
                let crumb: Element<_> = match msg {
                    Some(m) => button(t).padding([3, 2]).style(ghost(MUTED, TEXT_STRONG, false)).on_press(m).into(),
                    None => t.color(TEXT_STRONG).into(),
                };
                trail = trail.push(crumb);
            }
            r = r.push(container(trail).clip(true));
            r.into()
        }
        None => row![
            text("History").color(MUTED),
            text("/").color(SCROLLBAR_HOVER),
            button(
                row![text(branch.unwrap_or("detached HEAD").to_string()).font(MONO).size(12), Icon::CHEVRON_DOWN.view(12.0, TEXT_STRONG)]
                    .spacing(5)
                    .align_y(Alignment::Center)
            )
            .padding([5, 8])
            .style(ghost(TEXT_STRONG, TEXT_STRONG, true))
            .on_press(Message::NotInSpike("Switching branches")),
        ]
        .spacing(6)
        .align_y(Alignment::Center)
        .into(),
    };
    let labels = width > 700.0;
    let mut right = row![].spacing(8).align_y(Alignment::Center);
    if width > 380.0 {
        right = right.push(group(vec![icon_only(Icon::UNDO_2, false, "Undo"), icon_only(Icon::REDO_2, false, "Redo")]));
    }
    let caret = button(container(Icon::CHEVRON_DOWN.view(12.0, MUTED)).center_x(22).center_y(28))
        .padding(0)
        .style(crate::style::caret)
        .on_press(Message::NotInSpike("Pull options"));
    right = right.push(group(vec![
        tool_btn(Icon::REFRESH_CW, "Fetch", labels, "Fetch", true),
        tool_btn(Icon::ARROW_DOWN, "Pull", labels, "Pull", true),
        caret.into(),
        tool_btn(Icon::ARROW_UP, "Push", labels, "Push", true),
    ]));
    if width > 470.0 {
        right = right.push(group(vec![
            tool_btn(Icon::GIT_BRANCH, "Branch", labels, "Creating a branch", true),
            tool_btn(Icon::ARCHIVE, "Stash", labels, "Stashing", true),
            tool_btn(Icon::ARCHIVE_RESTORE, "Pop", labels, "Popping a stash", can_pop),
        ]));
    }
    column![
        container(row![container(left).width(Length::Fill).clip(true), right].spacing(12).align_y(Alignment::Center))
            .height(TOOLBAR_H - 1.0)
            .padding(iced::Padding { left: 14.0, right: 10.0, top: 0.0, bottom: 0.0 })
            .align_y(Alignment::Center)
            .width(Length::Fill)
            .style(fill(BG_TOOLBAR)),
        hline(DIVIDER),
    ]
    .into()
}

// ---- status bar ----

pub fn status_bar<'a>(branch: Option<&str>, fetched_at: Option<f64>, changes: usize, now: i64) -> Element<'a, Message> {
    let mut r = row![
        row![
            container(Space::new()).width(7).height(7).style(|_| container::Style {
                background: Some(Background::Color(ACCENT)),
                border: Border { radius: 3.5.into(), ..Border::default() },
                ..Default::default()
            }),
            text(branch.unwrap_or("no branch").to_string()).size(12).color(TEXT)
        ]
        .spacing(6)
        .align_y(Alignment::Center),
        text(match fetched_at {
            Some(ms) => format!("Fetched {}", relative_time((ms / 1000.0) as i64, now)),
            None => "Not fetched yet".into(),
        })
        .size(12)
        .color(MUTED),
    ]
    .spacing(16)
    .align_y(Alignment::Center);
    if changes > 0 {
        r = r.push(
            button(text(format!("{changes} uncommitted change{}", if changes == 1 { "" } else { "s" })).size(12))
                .padding(0)
                .style(ghost(ORANGE, TEXT_STRONG, false))
                .on_press(Message::ShowChanges),
        );
    }
    let shortcut = if cfg!(target_os = "macos") { "⌘P" } else { "Ctrl+P" };
    r = r.push(Space::new().width(Length::Fill)).push(
        button(text(shortcut).font(MONO).size(11))
            .padding(0)
            .style(ghost(MUTED, TEXT_STRONG, false))
            .on_press(Message::NotInSpike("The command palette")),
    );
    column![
        hline(BORDER_SOFT),
        container(r).height(23).padding([0, 12]).align_y(Alignment::Center).width(Length::Fill).style(fill(BG_TABBAR))
    ]
    .into()
}

// ---- toasts ----

pub fn toast<'a>(id: u64, kind: ToastKind, msg: &str) -> Element<'a, Message> {
    let (edge, icon) = match kind {
        ToastKind::Info => (BLUE, Icon::INFO),
        ToastKind::Success => (GREEN, Icon::CIRCLE_CHECK),
        ToastKind::Error => (RED, Icon::TRIANGLE_ALERT),
    };
    let body = row![
        container(Space::new()).width(4).height(Length::Fill).style(fill(edge)),
        container(
            row![
                container(icon.view(16.0, edge)).padding(iced::Padding { top: 1.0, ..Default::default() }),
                text(msg.to_string()).width(Length::Fill),
                button(Icon::X.view(14.0, MUTED)).padding(3).style(icon_btn).on_press(Message::DismissToast(id)),
            ]
            .spacing(8),
        )
        .padding(iced::Padding { top: 10.0, right: 10.0, bottom: 10.0, left: 12.0 }),
    ]
    .height(Length::Shrink);
    container(body).max_width(460).style(crate::style::toast).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_repo_initials() {
        assert_eq!(repo_initials("big"), "BI");
        assert_eq!(repo_initials("big-repo"), "BR");
        assert_eq!(repo_initials("my_cool.app"), "MC");
    }

    #[test]
    fn reads_tracking_counts() {
        assert_eq!(track(Some("ahead 1, behind 2")), (1, 2));
        assert_eq!(track(Some("gone")), (0, 0));
        assert_eq!(track(None), (0, 0));
    }

    #[test]
    fn nests_branches_in_folders() {
        let r = |name: &str| Ref {
            full: format!("refs/heads/{name}"),
            name: name.into(),
            kind: RefType::Local,
            remote: None,
            sha: "s".into(),
            upstream: None,
            track: None,
            is_head: false,
        };
        let refs = [r("main"), r("claude/happy"), r("claude/sad")];
        let t = tree(refs.iter(), 0);
        assert_eq!(t.children.keys().collect::<Vec<_>>(), vec!["claude/", "main"]);
        assert_eq!(t.children["claude/"].children.len(), 2);
    }
}
