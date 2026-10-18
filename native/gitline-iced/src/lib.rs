//! Gitline's spike screen in iced: the same screen as the Slint version, in iced's Elm-style
//! architecture. `App::update` turns messages into `gitline_core::session::Session` actions and
//! `App::view` draws the session.
use std::sync::Arc;

use gitline_core::format::{format_date, split_path};
use gitline_core::session::{FileList, Session};
use gitline_core::view::{DiffView, graph_width};
use gitline_core::{FileChange, FileStatus, Repo};
use iced::widget::{Space, button, column, container, hover, row, scrollable, text, text_editor, text_input};
use iced::{Alignment, Element, Length, Task};

pub mod diff;
pub mod graph;
pub mod style;

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

#[derive(Debug, Clone)]
pub enum Message {
    SelectCommit(usize),
    GraphScrolled(scrollable::Viewport),
    OpenFile(FileList, usize),
    StageFile(usize),
    UnstageFile(usize),
    StageAll,
    UnstageAll,
    CloseDiff,
    ToggleFile,
    ApplyHunk(usize),
    ApplyLines,
    Copy,
    DiffAction(text_editor::Action),
    DiffScrolled(scrollable::Viewport),
    Summary(String),
    Description(text_editor::Action),
    Commit,
    Highlighted(Highlighted),
}

/// The diff's scrollable, so wheel events over the text can scroll it and a new diff starts at the top.
const DIFF_SCROLL: &str = "diff-scroll";

pub struct App {
    pub session: Session,
    highlighting: Highlighting,
    graph_offset: f32,
    graph_height: f32,
    /// The open diff as editor text, and the view it was built from.
    pub diff_content: text_editor::Content,
    shown: Option<Arc<DiffView>>,
    /// The first diff row in the editor (see diff::WINDOW).
    diff_start: usize,
    diff_version: u64,
    diff_offset: f32,
    diff_height: f32,
    pub summary: String,
    pub description: text_editor::Content,
    pub status: String,
    pub status_error: bool,
    /// Widget operations queued by `sync_diff`, returned with the next update's task.
    pending: Vec<Task<Message>>,
}

impl App {
    pub fn open(repo: Repo, highlighting: Highlighting) -> Result<App, String> {
        let session = Session::open(repo).map_err(|e| e.0)?;
        Ok(App {
            session,
            highlighting,
            graph_offset: 0.0,
            graph_height: 1200.0,
            diff_content: text_editor::Content::new(),
            shown: None,
            diff_start: 0,
            diff_version: 0,
            diff_offset: 0.0,
            diff_height: 1200.0,
            summary: String::new(),
            description: text_editor::Content::new(),
            status: String::new(),
            status_error: false,
            pending: Vec::new(),
        })
    }

    pub fn title(&self) -> String {
        format!("Gitline (iced spike) - {}", self.session.name())
    }

    /// Runs a session action, shows its outcome in the status bar and syncs the diff editor.
    fn act(&mut self, done: &str, f: impl FnOnce(&mut Session) -> gitline_core::Result<()>) -> Task<Message> {
        match f(&mut self.session) {
            Ok(()) => {
                self.status = done.into();
                self.status_error = false;
            }
            Err(e) => {
                self.status = e.0.lines().next().unwrap_or("").into();
                self.status_error = true;
            }
        }
        self.sync_diff();
        let highlight = self.start_highlight();
        Task::batch(self.pending.drain(..).chain([highlight]))
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
        let same_rows = self
            .shown
            .as_ref()
            .is_some_and(|s| s.rows.len() == view.rows.len() && s.rows.iter().zip(&view.rows).all(|(a, b)| a.text == b.text));
        self.shown = Some(view);
        if !same_rows {
            self.diff_offset = 0.0;
            self.diff_start = 0;
            self.fill_editor(None);
            self.pending.push(iced::widget::operation::snap_to(DIFF_SCROLL, scrollable::RelativeOffset::START));
        }
        self.diff_version += 1;
    }

    /// Loads the editor with the window of rows starting at `diff_start`, carrying a selection over
    /// from a window that started at `old_start`.
    fn fill_editor(&mut self, old_start: Option<usize>) {
        let Some(view) = self.shown.clone() else { return };
        let end = (self.diff_start + diff::WINDOW).min(view.rows.len());
        let cursor = self.diff_content.cursor();
        self.diff_content = text_editor::Content::with_text(&diff::editor_text(&view, self.diff_start..end));
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

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::SelectCommit(i) => self.act("", |s| s.select(i)),
            Message::GraphScrolled(v) => {
                self.graph_offset = v.absolute_offset().y;
                self.graph_height = v.bounds().height;
                Task::none()
            }
            Message::OpenFile(list, i) => self.act("", |s| s.open_file(list, i)),
            Message::StageFile(i) => self.act("Staged", |s| s.stage_file(i)),
            Message::UnstageFile(i) => self.act("Unstaged", |s| s.unstage_file(i)),
            Message::StageAll => self.act("Staged all files", Session::stage_all),
            Message::UnstageAll => self.act("Unstaged all files", Session::unstage_all),
            Message::CloseDiff => self.act("", |s| {
                s.close_diff();
                Ok(())
            }),
            Message::ToggleFile => self.act("Done", Session::toggle_open_file),
            Message::ApplyHunk(h) => self.act("Applied hunk", |s| s.apply_hunk(h)),
            Message::ApplyLines => {
                let (a, b) = diff::selected_rows(&self.diff_content, self.diff_start);
                self.act("Applied selected lines", |s| s.apply_lines(a, b))
            }
            Message::Copy => match self.diff_content.selection() {
                Some(t) => {
                    let lines = t.lines().count();
                    self.status = format!("Copied {lines} line{}", if lines == 1 { "" } else { "s" });
                    self.status_error = false;
                    iced::clipboard::write(t)
                }
                None => Task::none(),
            },
            Message::DiffAction(action) => match action {
                // The editor is as tall as its text, so the wheel scrolls the list it sits in.
                text_editor::Action::Scroll { lines } => {
                    iced::widget::operation::scroll_by(DIFF_SCROLL, scrollable::AbsoluteOffset { x: 0.0, y: lines as f32 * diff::LINE_H })
                }
                // Read-only: selection and movement, but no edits.
                a if a.is_edit() => Task::none(),
                a => {
                    self.diff_content.perform(a);
                    Task::none()
                }
            },
            Message::DiffScrolled(v) => {
                self.diff_offset = v.absolute_offset().y;
                self.diff_height = v.bounds().height;
                if let Some(count) = self.shown.as_ref().map(|v| v.rows.len()) {
                    let (first, last) = diff::visible(count, self.diff_offset, self.diff_height);
                    if let Some(start) = diff::window_start(count, self.diff_start, first, last) {
                        let old = std::mem::replace(&mut self.diff_start, start);
                        self.fill_editor(Some(old));
                    }
                }
                Task::none()
            }
            Message::Summary(s) => {
                self.summary = s;
                Task::none()
            }
            Message::Description(action) => {
                self.description.perform(action);
                Task::none()
            }
            Message::Commit => {
                if !self.session.can_commit(&self.summary) {
                    return Task::none();
                }
                let (summary, description) = (self.summary.clone(), self.description.text());
                let task = self.act("Committed", |s| s.commit(&summary, &description));
                if !self.status_error {
                    self.summary.clear();
                    self.description = text_editor::Content::new();
                }
                task
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

    /// Selects rows `first..=last` of the open diff, as dragging over them would. (For tests.)
    pub fn select_diff_rows(&mut self, first: usize, last: usize) {
        use text_editor::{Cursor, Position};
        let line = |row: usize| row - self.diff_start;
        let end = self.diff_content.line(line(last)).map_or(0, |l| l.text.chars().count());
        self.diff_content.move_to(Cursor {
            position: Position { line: line(last), column: end },
            selection: Some(Position { line: line(first), column: 0 }),
        });
    }

    pub fn view(&self) -> Element<'_, Message> {
        let s = &self.session;
        let toolbar = container(
            row![
                text(s.name()).font(SANS_BOLD).color(TEXT_STRONG),
                text(s.info.branch.clone().unwrap_or_else(|| "detached HEAD".into())).font(MONO).size(12).color(ACCENT),
            ]
            .spacing(10)
            .align_y(Alignment::Center),
        )
        .padding([0, 14])
        .height(40)
        .width(Length::Fill)
        .align_y(Alignment::Center)
        .style(panel(BG_PANEL));

        let center: Element<_> = match &s.diff {
            None => {
                let st = &s.status;
                let counts: Vec<String> =
                    [(st.staged.len(), "staged"), (st.unstaged.len(), "unstaged"), (st.conflicted.len(), "conflicted")]
                        .iter()
                        .filter(|(n, _)| *n > 0)
                        .map(|(n, w)| format!("{n} {w}"))
                        .collect();
                let wip_label = format!("Uncommitted changes · {}", counts.join(", "));
                let list = graph::view(graph::GraphProps {
                    history: &s.history,
                    head: s.info.head.as_deref(),
                    detached: s.info.head.is_some() && s.info.branch.is_none(),
                    selected: s.selected,
                    graph_width: graph_width(s.history.graph.max_lanes),
                    wip_label,
                    offset: self.graph_offset,
                    height: self.graph_height,
                });
                scrollable(list).on_scroll(Message::GraphScrolled).height(Length::Fill).into()
            }
            Some(d) => {
                let (a, b) = diff::selected_rows(&self.diff_content, self.diff_start);
                let selecting = diff::has_selection(&self.diff_content);
                let changes = if selecting { (a..=b).filter(|&r| d.view.is_change(r)).count() } else { 0 };
                let mut bar = row![
                    text(match &d.file.old_path {
                        Some(old) => format!("{old} → {}", d.file.path),
                        None => d.file.path.clone(),
                    })
                    .font(MONO)
                    .size(12)
                    .color(TEXT_STRONG)
                    .width(Length::Fill),
                    text(if d.view.parsed.binary {
                        "Binary file".to_string()
                    } else if !d.highlighted {
                        "Highlighting…".into()
                    } else {
                        gitline_core::highlight::Highlighter::global().language_name(&d.file.path).unwrap_or("Plain text").into()
                    })
                    .size(12)
                    .color(MUTED),
                ]
                .spacing(6)
                .align_y(Alignment::Center);
                let staged = d.list == FileList::Staged;
                if d.can_apply() && changes > 0 {
                    let verb = if staged { "Unstage" } else { "Stage" };
                    bar = bar.push(
                        button(text(format!("{verb} {changes} line{}", if changes == 1 { "" } else { "s" })))
                            .style(flat)
                            .on_press(Message::ApplyLines),
                    );
                }
                if selecting {
                    bar = bar.push(button("Copy").style(flat).on_press(Message::Copy));
                }
                if d.list != FileList::Commit && d.file.status != FileStatus::Conflicted {
                    bar = bar.push(button(if staged { "Unstage file" } else { "Stage file" }).style(flat).on_press(Message::ToggleFile));
                }
                bar = bar.push(button("Close").style(flat).on_press(Message::CloseDiff));
                let body = diff::body(diff::DiffProps {
                    view: &d.view,
                    content: &self.diff_content,
                    colors: diff::Colors { version: self.diff_version, view: d.view.clone(), start: self.diff_start },
                    start: self.diff_start,
                    can_apply: d.can_apply(),
                    staged,
                    offset: self.diff_offset,
                    height: self.diff_height,
                });
                column![
                    container(bar).padding([0, 12]).height(40).align_y(Alignment::Center).style(header),
                    scrollable(body).id(DIFF_SCROLL).on_scroll(Message::DiffScrolled).height(Length::Fill),
                ]
                .into()
            }
        };

        let right: Element<_> = if s.wip_selected() {
            let can_commit = s.can_commit(&self.summary);
            let n = s.status.staged.len();
            let commit_label =
                if n == 0 { "Stage files to commit".to_string() } else { format!("Commit {n} file{}", if n == 1 { "" } else { "s" }) };
            column![
                panel_header(
                    format!("Unstaged files ({})", s.status.unstaged.len()),
                    Some(("Stage all", (!s.status.unstaged.is_empty()).then_some(Message::StageAll)))
                ),
                scrollable(file_list(&s.status.unstaged, FileList::Unstaged, self.active(FileList::Unstaged), Some("Stage")))
                    .height(Length::Fill),
                panel_header(format!("Staged files ({n})"), Some(("Unstage all", (n > 0).then_some(Message::UnstageAll)))),
                scrollable(file_list(&s.status.staged, FileList::Staged, self.active(FileList::Staged), Some("Unstage")))
                    .height(Length::Fill),
                container(
                    column![
                        text("Commit").font(SANS_BOLD),
                        text_input("Summary", &self.summary).on_input(Message::Summary).on_submit(Message::Commit).padding(6).style(input),
                        text_editor(&self.description)
                            .placeholder("Description")
                            .on_action(Message::Description)
                            .height(72)
                            .padding(6)
                            .style(editor),
                        button(container(text(commit_label).font(SANS_BOLD)).center_x(Length::Fill))
                            .width(Length::Fill)
                            .style(primary)
                            .on_press_maybe(can_commit.then_some(Message::Commit)),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .style(panel(BG_PANEL_2)),
            ]
            .into()
        } else {
            let d = s.details.as_ref();
            let message = d.map_or("", |d| d.message.as_str());
            let (title, body) = message.split_once('\n').map_or((message, ""), |(t, b)| (t, b.trim()));
            let mut meta = d.map_or(String::new(), |d| {
                format!("{} <{}>\n{} · {}", d.author, d.email, format_date(d.time), &d.sha[..10.min(d.sha.len())])
            });
            if let Some(d) = d
                && (d.committer != d.author || d.committer_email != d.email)
            {
                meta.push_str(&format!("\nCommitted by {} on {}", d.committer, format_date(d.commit_time)));
            }
            let mut info = column![text(title.to_string()).font(SANS_BOLD).color(TEXT_STRONG), text(meta).size(12).color(MUTED)].spacing(6);
            if !body.is_empty() {
                info = info.push(text(body.to_string()).size(12));
            }
            let files = s.files(FileList::Commit);
            column![
                container(info).padding(12).width(Length::Fill).style(panel(BG_PANEL_2)),
                panel_header(format!("{} file{} changed", files.len(), if files.len() == 1 { "" } else { "s" }), None),
                scrollable(file_list(files, FileList::Commit, self.active(FileList::Commit), None)).height(Length::Fill),
            ]
            .into()
        };

        let status = container(text(self.status.clone()).size(12).color(if self.status_error { RED } else { MUTED }))
            .padding([0, 12])
            .height(24)
            .width(Length::Fill)
            .align_y(Alignment::Center)
            .style(panel(BG_PANEL));

        column![
            toolbar,
            row![
                container(center).width(Length::Fill).height(Length::Fill).style(panel(BG_GRAPH)),
                container(Space::new()).width(1).height(Length::Fill).style(panel(BORDER)),
                container(right).width(320).height(Length::Fill).style(panel(BG_PANEL)),
            ]
            .height(Length::Fill),
            status,
        ]
        .into()
    }

    /// Which row of `list` has its diff open.
    fn active(&self, list: FileList) -> Option<usize> {
        let d = self.session.diff.as_ref().filter(|d| d.list == list)?;
        self.session.files(list).iter().position(|f| f.path == d.file.path)
    }
}

fn panel_header<'a>(title: String, action: Option<(&'a str, Option<Message>)>) -> Element<'a, Message> {
    let mut r = row![text(title).font(SANS_BOLD).width(Length::Fill)].align_y(Alignment::Center);
    if let Some((label, msg)) = action {
        r = r.push(button(text(label).size(12)).padding([2, 7]).style(flat).on_press_maybe(msg));
    }
    container(r).padding([0, 12]).height(34).align_y(Alignment::Center).style(header).into()
}

fn status_color(s: FileStatus) -> iced::Color {
    match s {
        FileStatus::Added | FileStatus::Untracked => GREEN,
        FileStatus::Deleted => RED,
        FileStatus::Renamed | FileStatus::Copied => style::hex(0x4f8cff),
        FileStatus::Conflicted => ORANGE,
        FileStatus::Modified | FileStatus::TypeChanged => YELLOW,
    }
}

fn file_list<'a>(files: &'a [FileChange], list: FileList, active: Option<usize>, action: Option<&'a str>) -> Element<'a, Message> {
    column(files.iter().enumerate().map(|(i, f)| {
        let (dir, name) = split_path(&f.path);
        let base = button(
            row![
                text(f.status.as_char().to_string()).font(MONO).color(status_color(f.status)).width(12),
                text(name).wrapping(text::Wrapping::None),
                text(dir.trim_end_matches('/')).size(12).color(MUTED).wrapping(text::Wrapping::None),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        )
        .padding([4, 14])
        .width(Length::Fill)
        .height(26)
        .style(style::row_button(active == Some(i)))
        .on_press(Message::OpenFile(list, i));
        match action {
            // Shown on hover, as in the Electron app.
            Some(label) => {
                let msg = if list == FileList::Staged { Message::UnstageFile(i) } else { Message::StageFile(i) };
                let act = button(text(label).size(12)).padding([2, 7]).style(flat).on_press(msg);
                hover(base, container(act).align_right(Length::Fill).padding([2, 8]))
            }
            None => base.into(),
        }
    }))
    .into()
}
