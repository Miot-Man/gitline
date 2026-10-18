//! Gitline's spike screen in iced, laid out like the Electron app: the rail, the branches sidebar, the
//! toolbar and graph (or a diff in its place), the right panel and the status bar. `App::update` turns
//! messages into `gitline_core::session::Session` actions and `App::view` draws the session.
//!
//! Buttons for features the spike doesn't have yet look the same as in the Electron app, and say so in
//! a toast when clicked.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gitline_core::format::now;
use gitline_core::session::{FileList, Session};
use gitline_core::view::{DiffView, ROW_H, RowKind, graph_width};
use gitline_core::{Ref, Repo, WIP};
use iced::widget::{Space, column, container, operation, responsive, row, scrollable, stack, text_editor};
use iced::{Alignment, Element, Length, Subscription, Task, keyboard};

pub mod diff;
pub mod graph;
pub mod icons;
pub mod panel;
pub mod shell;
pub mod smooth;
pub mod style;

use smooth::{Smooth, wheel};
use style::*;

/// How highlighted diffs arrive: from a worker thread (the app), or computed inline (headless tests).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Highlighting {
    Background,
    Inline,
}

/// A highlighted diff coming back from the worker thread.
#[derive(Clone)]
pub struct Highlighted(pub u64, pub Arc<DiffView>);

impl std::fmt::Debug for Highlighted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Highlighted({}, {} rows)", self.0, self.1.rows.len())
    }
}

/// A collapsible section (sidebar sections and folders, the ignored files).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section(pub String);

/// The scroll areas that scroll smoothly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Graph,
    Diff,
    Sidebar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastKind {
    Info,
    Success,
    Error,
}

/// The diff's language picker: plain text, or the language picked from the file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lang {
    Plain,
    Auto(String),
}

impl std::fmt::Display for Lang {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Lang::Plain => f.write_str("Plain text"),
            Lang::Auto(name) => write!(f, "{name} (auto)"),
        }
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    SelectCommit(usize),
    LoadMore,
    /// Selects the commit with this sha and scrolls it into view.
    JumpTo(String),
    ShowHistory,
    ShowChanges,
    OpenFile(FileList, usize),
    StageFile(usize),
    UnstageFile(usize),
    StageAll,
    UnstageAll,
    CloseDiff,
    ToggleFile,
    ApplyHunk(usize),
    ApplyLines,
    ClearDiffSelection,
    ToggleIgnoreWs,
    SetPlain(bool),
    DiffAction(text_editor::Action),
    Scrolled(Area, scrollable::Viewport),
    Wheel(Area, f32),
    Frame(Instant),
    Key(keyboard::key::Named),
    Summary(String),
    Description(text_editor::Action),
    Amend(bool),
    Commit,
    CopySha(String),
    SidebarFilter(String),
    Toggle(Section),
    NotInSpike(&'static str),
    DismissToast(u64),
    Highlighted(Highlighted),
}

const GRAPH_SCROLL: &str = "graph-scroll";
const DIFF_SCROLL: &str = "diff-scroll";
const SIDEBAR_SCROLL: &str = "sidebar-scroll";
/// The Electron app's default panel widths, less the 1px each splitter line overlaps.
const SIDEBAR_W: f32 = 229.0;
const RIGHT_W: f32 = 339.0;

pub struct App {
    pub session: Session,
    highlighting: Highlighting,
    graph: Smooth,
    graph_height: f32,
    sidebar: Smooth,
    /// The open diff: the editor's text (a window of it), the view and layout it was built from.
    pub diff_content: text_editor::Content,
    shown: Option<Arc<DiffView>>,
    layout: Arc<diff::Layout>,
    /// The first slot of the diff in the editor (see diff::WINDOW).
    diff_start: usize,
    diff_version: u64,
    diff: Smooth,
    diff_height: f32,
    pub summary: String,
    pub description: text_editor::Content,
    pub amend: bool,
    side_filter: String,
    collapsed: HashSet<String>,
    ignored_open: bool,
    /// All refs, by name, and each commit's lane colour (for the sidebar).
    refs: Vec<Ref>,
    lane_colors: HashMap<String, u32>,
    pub toasts: Vec<(u64, ToastKind, String)>,
    next_toast: u64,
    /// Widget operations queued while syncing, returned with the update's task.
    pending: Vec<Task<Message>>,
}

impl App {
    pub fn open(repo: Repo, highlighting: Highlighting) -> Result<App, String> {
        let session = Session::open(repo).map_err(|e| e.0)?;
        let mut app = App {
            session,
            highlighting,
            graph: Smooth::default(),
            graph_height: 1200.0,
            sidebar: Smooth::default(),
            diff_content: text_editor::Content::new(),
            shown: None,
            layout: Arc::new(diff::Layout { slots: Vec::new() }),
            diff_start: 0,
            diff_version: 0,
            diff: Smooth::default(),
            diff_height: 1200.0,
            summary: String::new(),
            description: text_editor::Content::new(),
            amend: false,
            side_filter: String::new(),
            collapsed: HashSet::new(),
            ignored_open: false,
            refs: Vec::new(),
            lane_colors: HashMap::new(),
            toasts: Vec::new(),
            next_toast: 0,
            pending: Vec::new(),
        };
        app.sync_refs();
        Ok(app)
    }

    pub fn title(&self) -> String {
        format!("Gitline (iced spike) - {}", self.session.name())
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let keys = iced::event::listen_with(|event, status, _| match (event, status) {
            (iced::Event::Keyboard(keyboard::Event::KeyPressed { key: keyboard::Key::Named(k), .. }), iced::event::Status::Ignored) => {
                matches!(k, keyboard::key::Named::Escape | keyboard::key::Named::ArrowUp | keyboard::key::Named::ArrowDown)
                    .then_some(Message::Key(k))
            }
            _ => None,
        });
        let animating = self.graph.animating() || self.diff.animating() || self.sidebar.animating();
        if animating { Subscription::batch([keys, iced::window::frames().map(Message::Frame)]) } else { keys }
    }

    fn toast(&mut self, kind: ToastKind, msg: impl Into<String>) -> Task<Message> {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push((id, kind, msg.into()));
        let ms = if kind == ToastKind::Error { 9000 } else { 3500 };
        Task::perform(sleep(Duration::from_millis(ms)), move |_| Message::DismissToast(id))
    }

    /// Runs a session action and shows its error, if any, in a toast; then syncs the view with it.
    fn act(&mut self, f: impl FnOnce(&mut Session) -> gitline_core::Result<()>) -> Task<Message> {
        let result = f(&mut self.session);
        self.sync_refs();
        self.sync_diff();
        let highlight = self.start_highlight();
        let toast = match result {
            Ok(()) => Task::none(),
            Err(e) => self.toast(ToastKind::Error, e.0),
        };
        Task::batch(self.pending.drain(..).chain([highlight, toast]))
    }

    /// The sidebar's refs and lane colours, after a reload.
    fn sync_refs(&mut self) {
        let h = &self.session.history;
        let mut refs: Vec<Ref> = h.refs_by_sha.values().flatten().cloned().collect();
        refs.sort_by(|a, b| a.name.cmp(&b.name));
        self.refs = refs;
        self.lane_colors =
            (0..h.commits.len()).filter(|&i| h.commits[i].sha != WIP).map(|i| (h.commits[i].sha.clone(), h.lane_color(i))).collect();
    }

    /// Rebuilds the editor when another diff opened; keeps it (and its selection) when only the colours
    /// changed.
    fn sync_diff(&mut self) {
        let Some(view) = self.session.diff.as_ref().map(|d| d.view.clone()) else {
            self.shown = None;
            return;
        };
        if self.shown.as_ref().is_some_and(|s| Arc::ptr_eq(s, &view)) {
            return;
        }
        let same_rows = self.shown.as_ref().is_some_and(|s| {
            s.rows.len() == view.rows.len() && s.rows.iter().zip(&view.rows).all(|(a, b)| a.text == b.text && a.kind == b.kind)
        });
        self.layout = Arc::new(diff::Layout::new(&view));
        self.shown = Some(view);
        if !same_rows {
            self.diff = Smooth::default();
            self.diff_start = 0;
            self.fill_editor(None);
            self.pending.push(operation::snap_to(DIFF_SCROLL, scrollable::RelativeOffset::START));
        }
        self.diff_version += 1;
    }

    /// Loads the editor with the window of slots starting at `diff_start`, carrying a selection over
    /// from a window that started at `old_start`.
    fn fill_editor(&mut self, old_start: Option<usize>) {
        let Some(view) = self.shown.clone() else { return };
        let end = (self.diff_start + diff::WINDOW).min(self.layout.slots.len());
        let cursor = self.diff_content.cursor();
        self.diff_content = text_editor::Content::with_text(&diff::editor_text(&view, &self.layout, self.diff_start..end));
        if let Some(old) = old_start {
            let len = end - self.diff_start;
            let shift = |p: text_editor::Position| {
                let line = (p.line + old).checked_sub(self.diff_start).filter(|&l| l < len)?;
                Some(text_editor::Position { line, column: p.column })
            };
            if let Some(position) = shift(cursor.position) {
                self.diff_content.move_to(text_editor::Cursor { position, selection: cursor.selection.and_then(shift) });
            }
        }
        self.diff_version += 1;
    }

    fn start_highlight(&mut self) -> Task<Message> {
        let Some(job) = self.session.highlight_job() else { return Task::none() };
        match self.highlighting {
            Highlighting::Inline => {
                let (generation, view) = job.run();
                if self.session.finish_highlight(generation, view) {
                    self.sync_diff();
                }
                Task::none()
            }
            Highlighting::Background => Task::perform(
                async move {
                    let (tx, rx) = iced::futures::channel::oneshot::channel();
                    std::thread::spawn(move || {
                        let _ = tx.send(job.run());
                    });
                    rx.await.ok()
                },
                |r| match r {
                    Some((generation, view)) => Message::Highlighted(Highlighted(generation, Arc::new(view))),
                    None => Message::Highlighted(Highlighted(u64::MAX, Arc::new(DiffView::build_plain("")))),
                },
            ),
        }
    }

    /// The diff rows the editor's selection touches, if it touches any.
    fn selected_rows(&self) -> Option<(usize, usize)> {
        let (a, b) = diff::selected_slots(&self.diff_content, self.diff_start);
        self.layout.rows_between(a, b)
    }

    /// Scrolls the graph so row `i` is in view (centred if it wasn't).
    fn reveal(&self, i: usize) -> Task<Message> {
        let top = i as f32 * ROW_H;
        if top >= self.graph.offset && top + ROW_H <= self.graph.offset + self.graph_height {
            return Task::none();
        }
        let y = (top - self.graph_height / 2.0 + ROW_H / 2.0).max(0.0);
        operation::scroll_to(GRAPH_SCROLL, scrollable::AbsoluteOffset { x: 0.0, y })
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::SelectCommit(i) => self.act(|s| s.select(i)),
            Message::LoadMore => self.act(Session::load_more),
            Message::JumpTo(sha) => match self.session.history.commits.iter().position(|c| c.sha == sha) {
                Some(i) => {
                    let task = self.act(|s| s.select(i));
                    Task::batch([task, self.reveal(i)])
                }
                None => self.toast(ToastKind::Info, "That commit isn't in the loaded history."),
            },
            Message::ShowHistory => {
                let head = usize::from(self.session.wip_shown());
                let task = self.act(|s| {
                    s.close_diff();
                    if s.wip_selected() { s.select(head) } else { Ok(()) }
                });
                Task::batch([task, self.reveal(head)])
            }
            Message::ShowChanges => {
                if !self.session.wip_shown() {
                    return self.toast(ToastKind::Info, "No uncommitted changes");
                }
                let task = self.act(|s| s.select(0));
                Task::batch([task, self.reveal(0)])
            }
            Message::OpenFile(list, i) => self.act(|s| s.open_file(list, i)),
            Message::StageFile(i) => self.act(|s| s.stage_file(i)),
            Message::UnstageFile(i) => self.act(|s| s.unstage_file(i)),
            Message::StageAll => self.act(Session::stage_all),
            Message::UnstageAll => self.act(Session::unstage_all),
            Message::CloseDiff => self.act(|s| {
                s.close_diff();
                Ok(())
            }),
            Message::ToggleFile => self.act(Session::toggle_open_file),
            Message::ApplyHunk(h) => self.act(|s| s.apply_hunk(h)),
            Message::ApplyLines => match self.selected_rows() {
                Some((a, b)) => self.act(|s| s.apply_lines(a, b)),
                None => Task::none(),
            },
            Message::ClearDiffSelection => {
                // `move_to` with no selection keeps the old one, so collapse it onto the cursor instead.
                let position = self.diff_content.cursor().position;
                self.diff_content.move_to(text_editor::Cursor { position, selection: Some(position) });
                Task::none()
            }
            Message::ToggleIgnoreWs => {
                let on = !self.session.ignore_ws;
                self.act(|s| s.set_ignore_ws(on))
            }
            Message::SetPlain(on) => self.act(|s| s.set_plain(on)),
            Message::DiffAction(action) => match action {
                // The editor is as tall as its text, so the wheel scrolls the list it sits in.
                text_editor::Action::Scroll { lines } => self.update(Message::Wheel(Area::Diff, lines as f32 * diff::LINE_H)),
                // Read-only: selection and movement, but no edits.
                a if a.is_edit() => Task::none(),
                a => {
                    self.diff_content.perform(a);
                    Task::none()
                }
            },
            Message::Scrolled(area, v) => {
                let (offset, height, content) = (v.absolute_offset().y, v.bounds().height, v.content_bounds().height);
                match area {
                    Area::Graph => {
                        self.graph.scrolled(offset, content - height);
                        self.graph_height = height;
                    }
                    Area::Sidebar => self.sidebar.scrolled(offset, content - height),
                    Area::Diff => {
                        self.diff.scrolled(offset, content - height);
                        self.diff_height = height;
                        let count = self.layout.slots.len();
                        let (first, last) = diff::visible(count, offset, height);
                        if let Some(start) = diff::window_start(count, self.diff_start, first, last) {
                            let old = std::mem::replace(&mut self.diff_start, start);
                            self.fill_editor(Some(old));
                        }
                    }
                }
                Task::none()
            }
            Message::Wheel(area, dy) => {
                match area {
                    Area::Graph => self.graph.wheel(dy),
                    Area::Diff => self.diff.wheel(dy),
                    Area::Sidebar => self.sidebar.wheel(dy),
                }
                Task::none()
            }
            Message::Frame(now) => {
                let mut tasks = Vec::new();
                for (smooth, id) in [(&mut self.graph, GRAPH_SCROLL), (&mut self.diff, DIFF_SCROLL), (&mut self.sidebar, SIDEBAR_SCROLL)] {
                    if let Some(y) = smooth.tick(now) {
                        tasks.push(operation::scroll_to(id, scrollable::AbsoluteOffset { x: 0.0, y }));
                    }
                }
                Task::batch(tasks)
            }
            Message::Key(key) => match key {
                keyboard::key::Named::Escape if self.session.diff.is_some() => self.update(Message::CloseDiff),
                keyboard::key::Named::ArrowUp | keyboard::key::Named::ArrowDown if self.session.diff.is_none() => {
                    let last = self.session.history.commits.len().saturating_sub(1);
                    let i = if key == keyboard::key::Named::ArrowUp {
                        self.session.selected.saturating_sub(1)
                    } else {
                        (self.session.selected + 1).min(last)
                    };
                    let task = self.act(|s| s.select(i));
                    Task::batch([task, self.reveal(i)])
                }
                _ => Task::none(),
            },
            Message::Summary(s) => {
                self.summary = s;
                Task::none()
            }
            Message::Description(action) => {
                self.description.perform(action);
                Task::none()
            }
            Message::Amend(on) => {
                self.amend = on;
                // Ticking Amend fills in the last commit's message to edit.
                if on
                    && self.summary.is_empty()
                    && self.description.text().trim().is_empty()
                    && let Ok(m) = self.session.last_message()
                {
                    let (s, d) = m.split_once('\n').map_or((m.as_str(), ""), |(s, d)| (s, d.trim()));
                    self.summary = s.to_string();
                    self.description = text_editor::Content::with_text(d);
                }
                Task::none()
            }
            Message::Commit => {
                if !self.session.can_commit(&self.summary, self.amend) {
                    return Task::none();
                }
                let (summary, description, amend) = (self.summary.clone(), self.description.text(), self.amend);
                let result = self.session.commit(&summary, &description, amend);
                let ok = result.is_ok();
                let task = self.act(|_| result);
                if ok {
                    self.summary.clear();
                    self.description = text_editor::Content::new();
                    self.amend = false;
                }
                task
            }
            Message::CopySha(sha) => Task::batch([iced::clipboard::write(sha), self.toast(ToastKind::Success, "Copied to clipboard")]),
            Message::SidebarFilter(f) => {
                self.side_filter = f;
                Task::none()
            }
            Message::Toggle(Section(key)) => {
                if key == "ignored" {
                    self.ignored_open = !self.ignored_open;
                    if self.ignored_open && self.session.ignored.is_none() {
                        return self.act(Session::load_ignored);
                    }
                } else if !self.collapsed.remove(&key) {
                    self.collapsed.insert(key);
                }
                Task::none()
            }
            Message::NotInSpike("") => Task::none(),
            Message::NotInSpike(what) => self.toast(ToastKind::Info, format!("{what} isn't in the native spike yet.")),
            Message::DismissToast(id) => {
                self.toasts.retain(|t| t.0 != id);
                Task::none()
            }
            Message::Highlighted(Highlighted(generation, view)) => {
                if let Ok(view) = Arc::try_unwrap(view)
                    && self.session.finish_highlight(generation, view)
                {
                    self.sync_diff();
                }
                Task::none()
            }
        }
    }

    /// Selects from the start of diff row `first` to the end of row `last`, as dragging over them
    /// would. (For tests.)
    pub fn select_diff_rows(&mut self, first: usize, last: usize) {
        use text_editor::{Cursor, Position};
        let slot = |row: usize| self.layout.slots.iter().position(|s| *s == diff::Slot::Row(row)).unwrap() - self.diff_start;
        let (a, b) = (slot(first), slot(last));
        let end = self.diff_content.line(b).map_or(0, |l| l.text.chars().count());
        self.diff_content.move_to(Cursor { position: Position { line: b, column: end }, selection: Some(Position { line: a, column: 0 }) });
    }

    /// Which row of `list` has its diff open.
    fn active(&self, list: FileList) -> Option<usize> {
        let d = self.session.diff.as_ref().filter(|d| d.list == list)?;
        self.session.files(list).iter().position(|f| f.path == d.file.path)
    }

    pub fn view(&self) -> Element<'_, Message> {
        let s = &self.session;
        let changes = s.status.staged.len() + s.status.unstaged.len() + s.status.conflicted.len();

        let sidebar_props = shell::SidebarProps {
            refs: &self.refs,
            remotes: &s.info.remotes,
            stashes: &s.stashes,
            filter: &self.side_filter,
            collapsed: &self.collapsed,
            lane_colors: &self.lane_colors,
        };
        let sidebar = column![
            shell::sidebar_top(s.name(), &self.side_filter),
            wheel(
                scrollable(shell::sidebar_body(&sidebar_props))
                    .id(SIDEBAR_SCROLL)
                    .on_scroll(|v| Message::Scrolled(Area::Sidebar, v))
                    .height(Length::Fill)
                    .style(scrollbar),
                |dy| Message::Wheel(Area::Sidebar, dy),
            ),
        ]
        .width(SIDEBAR_W);

        let center = responsive(move |size| self.center(size.width)).width(Length::Fill);

        let right: Element<_> = if s.wip_selected() {
            panel::staging(panel::StagingProps {
                branch: s.info.branch.as_deref(),
                unstaged: &s.status.unstaged,
                staged: &s.status.staged,
                active: s.diff.as_ref().and_then(|d| self.active(d.list).map(|i| (d.list, i))),
                ignored: s.ignored.as_deref(),
                ignored_open: self.ignored_open,
                summary: &self.summary,
                description: &self.description,
                amend: self.amend,
                can_commit: s.can_commit(&self.summary, self.amend),
            })
        } else {
            match &s.details {
                Some(d) => panel::commit_panel(d, self.active(FileList::Commit), now()),
                None => Space::new().into(),
            }
        };

        let main = column![
            row![
                shell::rail(&s.name(), changes, !s.wip_selected()),
                container(sidebar).height(Length::Fill).style(fill(BG_PANEL)),
                shell::splitter(),
                container(center).width(Length::Fill).height(Length::Fill).style(fill(BG_GRAPH)),
                shell::splitter(),
                container(right).width(RIGHT_W).height(Length::Fill).style(fill(BG_PANEL)),
            ]
            .height(Length::Fill),
            shell::status_bar(s.info.branch.as_deref(), s.info.fetched_at, changes, now()),
        ];

        let toasts = column(self.toasts.iter().map(|(id, kind, msg)| shell::toast(*id, *kind, msg))).spacing(8).align_x(Alignment::End);
        stack![main, container(toasts).padding(16).align_right(Length::Fill).align_bottom(Length::Fill)].into()
    }

    /// The toolbar and the graph, or a diff in its place.
    fn center(&self, width: f32) -> Element<'_, Message> {
        let s = &self.session;
        let can_pop = !s.stashes.is_empty();
        let Some(d) = &s.diff else {
            let gw = graph_width(s.history.graph.max_lanes);
            let list = graph::view(graph::GraphProps {
                history: &s.history,
                head: s.info.head.as_deref(),
                detached: s.info.head.is_some() && s.info.branch.is_none(),
                selected: s.selected,
                graph_width: gw,
                wip: s.wip_label(),
                width,
                offset: self.graph.offset,
                height: self.graph_height,
                now: now(),
                can_load_more: s.can_load_more(),
            });
            return column![
                shell::toolbar(s.info.branch.as_deref(), None, width, can_pop),
                graph::header(gw, width),
                wheel(
                    scrollable(list)
                        .id(GRAPH_SCROLL)
                        .on_scroll(|v| Message::Scrolled(Area::Graph, v))
                        .height(Length::Fill)
                        .style(scrollbar),
                    |dy| Message::Wheel(Area::Graph, dy),
                ),
            ]
            .into();
        };

        let middle = match &d.sha {
            Some(sha) => (sha[..7.min(sha.len())].to_string(), true, Some(Message::CloseDiff)),
            None => ("Uncommitted changes".to_string(), false, Some(Message::CloseDiff)),
        };
        let trail = vec![("History".to_string(), false, Some(Message::CloseDiff)), middle, (d.file.path.clone(), true, None)];
        let count = |k: RowKind| d.view.rows.iter().filter(|r| r.kind == k).count();
        let header = panel::diff_header(panel::DiffHeaderProps {
            file: &d.file,
            added: count(RowKind::Add),
            removed: count(RowKind::Del),
            binary: d.view.parsed.binary,
            wip: (d.list != FileList::Commit).then_some(d.list == FileList::Staged),
            language: gitline_core::highlight::Highlighter::global().language_name(&d.file.path),
            plain: s.plain,
            ignore_ws: s.ignore_ws,
            width,
        });
        let body: Element<_> = if d.view.parsed.binary {
            diff::message("Binary file — no text diff available.")
        } else if d.view.parsed.hunks.is_empty() {
            diff::message("No changes (file mode change or empty file).")
        } else {
            let actions = d.can_apply().then(|| diff::HunkActions {
                staged: d.list == FileList::Staged,
                selection: diff::has_selection(&self.diff_content)
                    .then(|| self.selected_rows())
                    .flatten()
                    .map(|(a, b)| (d.view.rows[a].hunk, (a..=b).filter(|&r| d.view.is_change(r)).count()))
                    .filter(|(_, n)| *n > 0),
            });
            let body = diff::body(diff::DiffProps {
                view: &d.view,
                layout: &self.layout,
                content: &self.diff_content,
                colors: diff::Colors {
                    version: self.diff_version,
                    view: d.view.clone(),
                    layout: self.layout.clone(),
                    start: self.diff_start,
                },
                start: self.diff_start,
                actions,
                offset: self.diff.offset,
                height: self.diff_height,
            });
            wheel(
                scrollable(body).id(DIFF_SCROLL).on_scroll(|v| Message::Scrolled(Area::Diff, v)).height(Length::Fill).style(scrollbar),
                |dy| Message::Wheel(Area::Diff, dy),
            )
            .into()
        };
        column![shell::toolbar(s.info.branch.as_deref(), Some(trail), width, can_pop), header, body].into()
    }
}

async fn sleep(d: Duration) {
    let (tx, rx) = iced::futures::channel::oneshot::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(d);
        let _ = tx.send(());
    });
    let _ = rx.await;
}
