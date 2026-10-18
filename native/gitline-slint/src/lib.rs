//! Gitline's spike screen in Slint. The window is described in `ui/app.slint`; this crate only maps
//! `gitline_core::session::Session` to its properties and its callbacks back to session actions.
use std::cell::RefCell;
use std::rc::Rc;

use gitline_core::format::{format_date, now};
use gitline_core::session::{FileList, Session};
use gitline_core::view::graph_width;
use gitline_core::{FileStatus, Repo};
use slint::{ComponentHandle, ModelRc, SharedString};

pub mod models;

slint::include_modules!();

use models::{DiffModel, HistoryModel, commit_meta, file_rows};

/// How highlighted diffs arrive: from a worker thread (the app), or computed inline (headless tests,
/// which have no event loop to post back to).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Highlighting {
    Background,
    Inline,
}

pub struct Controller {
    session: RefCell<Session>,
    app: slint::Weak<AppWindow>,
    highlighting: Highlighting,
}

thread_local! {
    static CONTROLLER: RefCell<Option<Rc<Controller>>> = const { RefCell::new(None) };
}

fn list_from(i: i32) -> FileList {
    match i {
        0 => FileList::Unstaged,
        1 => FileList::Staged,
        _ => FileList::Commit,
    }
}

impl Controller {
    fn app(&self) -> AppWindow {
        self.app.upgrade().expect("window alive")
    }

    /// Runs a session action and shows its error, if any, in the status bar.
    fn act(self: &Rc<Self>, what: &str, f: impl FnOnce(&mut Session) -> gitline_core::Result<()>) {
        let result = f(&mut self.session.borrow_mut());
        self.show_all();
        let app = self.app();
        match result {
            Ok(()) => {
                app.set_status_text(what.into());
                app.set_status_error(false);
            }
            Err(e) => {
                app.set_status_text(e.0.lines().next().unwrap_or("").into());
                app.set_status_error(true);
            }
        }
        self.start_highlight();
    }

    /// Pushes the whole session to the window.
    fn show_all(&self) {
        let app = self.app();
        let s = self.session.borrow();
        app.set_repo_name(s.name().into());
        app.set_branch(s.info.branch.clone().map_or_else(|| "detached HEAD".into(), SharedString::from));
        app.set_commits(ModelRc::new(HistoryModel {
            history: s.history.clone(),
            head: s.info.head.clone(),
            detached: s.info.head.is_some() && s.info.branch.is_none(),
            now: now(),
        }));
        app.set_graph_width(graph_width(s.history.graph.max_lanes));
        app.set_selected_commit(s.selected as i32);
        let st = &s.status;
        let mut counts = Vec::new();
        for (n, word) in [(st.staged.len(), "staged"), (st.unstaged.len(), "unstaged"), (st.conflicted.len(), "conflicted")] {
            if n > 0 {
                counts.push(format!("{n} {word}"));
            }
        }
        app.set_wip_label(format!("Uncommitted changes · {}", counts.join(", ")).into());
        app.set_wip_selected(s.wip_selected());
        app.set_unstaged(file_rows(&st.unstaged));
        app.set_staged(file_rows(&st.staged));
        match &s.details {
            Some(d) => {
                app.set_commit_title(d.message.lines().next().unwrap_or("").into());
                let body = d.message.split_once('\n').map_or("", |(_, b)| b.trim());
                app.set_commit_message(body.into());
                let mut meta = commit_meta(&d.author, &d.email, d.time, &d.sha);
                if d.committer_email != d.email || d.committer != d.author {
                    meta.push_str(&format!("\nCommitted by {} on {}", d.committer, format_date(d.commit_time)));
                }
                app.set_commit_meta(meta.into());
                app.set_commit_files(file_rows(&d.files));
            }
            None => app.set_commit_files(file_rows(&[])),
        }
        drop(s);
        self.show_diff(true);
    }

    fn show_diff(&self, reset_selection: bool) {
        let app = self.app();
        let s = self.session.borrow();
        let Some(d) = s.diff.as_ref() else {
            app.set_diff_open(false);
            app.set_active_list(-1);
            app.set_active_file(-1);
            return;
        };
        let list = match d.list {
            FileList::Unstaged => 0,
            FileList::Staged => 1,
            FileList::Commit => 2,
        };
        app.set_active_list(list);
        app.set_active_file(s.files(d.list).iter().position(|f| f.path == d.file.path).map_or(-1, |i| i as i32));
        let path = match &d.file.old_path {
            Some(old) => format!("{old} → {}", d.file.path),
            None => d.file.path.clone(),
        };
        app.set_diff_path(path.into());
        let note = if d.view.parsed.binary {
            "Binary file".to_string()
        } else if d.view.rows.is_empty() {
            "No changes to show".into()
        } else if !d.highlighted {
            "Highlighting…".into()
        } else {
            gitline_core::highlight::Highlighter::global().language_name(&d.file.path).unwrap_or("Plain text").into()
        };
        app.set_diff_note(note.into());
        app.set_diff_rows(ModelRc::new(DiffModel { view: d.view.clone() }));
        app.set_diff_can_apply(d.can_apply());
        app.set_diff_staged(d.list == FileList::Staged);
        app.set_diff_is_wip(d.list != FileList::Commit && d.file.status != FileStatus::Conflicted);
        if reset_selection {
            app.set_sel_anchor(-1);
            app.set_sel_cursor(-1);
            app.set_char_row(-1);
            app.set_sel_changes(0);
        }
        app.set_diff_open(true);
    }

    fn start_highlight(self: &Rc<Self>) {
        let Some(job) = self.session.borrow().highlight_job() else { return };
        match self.highlighting {
            Highlighting::Inline => {
                let (generation, view) = job.run();
                self.finish_highlight(generation, view);
            }
            Highlighting::Background => {
                std::thread::spawn(move || {
                    let (generation, view) = job.run();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(c) = CONTROLLER.with(|c| c.borrow().clone()) {
                            c.finish_highlight(generation, view);
                        }
                    });
                });
            }
        }
    }

    fn finish_highlight(&self, generation: u64, view: gitline_core::view::DiffView) {
        if self.session.borrow_mut().finish_highlight(generation, view) {
            // Same rows, now coloured: keep the selection.
            self.show_diff(false);
        }
    }

    fn selection_changed(&self) {
        let app = self.app();
        let s = self.session.borrow();
        let Some(d) = s.diff.as_ref() else { return };
        let (a, b) = (app.get_sel_anchor(), app.get_sel_cursor());
        let n = if a < 0 || b < 0 { 0 } else { (a.min(b)..=a.max(b)).filter(|&r| d.view.is_change(r as usize)).count() };
        app.set_sel_changes(n as i32);
    }
}

/// Opens the repository containing `path` in a new window, wired up and ready to show.
pub fn open(path: &std::path::Path, highlighting: Highlighting) -> Result<(AppWindow, Rc<Controller>), String> {
    open_repo(Repo::new(path), highlighting)
}

pub fn open_repo(repo: Repo, highlighting: Highlighting) -> Result<(AppWindow, Rc<Controller>), String> {
    let session = Session::open(repo).map_err(|e| e.0)?;
    let app = AppWindow::new().map_err(|e| e.to_string())?;
    let c = Rc::new(Controller { session: RefCell::new(session), app: app.as_weak(), highlighting });
    CONTROLLER.with(|slot| *slot.borrow_mut() = Some(c.clone()));

    let weak = Rc::downgrade(&c);
    let with = move |f: fn(&Rc<Controller>)| {
        let weak = weak.clone();
        move || {
            if let Some(c) = weak.upgrade() {
                f(&c)
            }
        }
    };
    let with_i = {
        let weak = Rc::downgrade(&c);
        move |f: fn(&Rc<Controller>, i32)| {
            let weak = weak.clone();
            move |i: i32| {
                if let Some(c) = weak.upgrade() {
                    f(&c, i)
                }
            }
        }
    };

    app.on_select_commit(with_i(|c, i| c.act("", |s| s.select(i as usize))));
    app.on_open_file({
        let weak = Rc::downgrade(&c);
        move |list, i| {
            if let Some(c) = weak.upgrade() {
                c.act("", |s| s.open_file(list_from(list), i as usize));
            }
        }
    });
    app.on_stage_file(with_i(|c, i| c.act("Staged", |s| s.stage_file(i as usize))));
    app.on_unstage_file(with_i(|c, i| c.act("Unstaged", |s| s.unstage_file(i as usize))));
    app.on_stage_all(with(|c| c.act("Staged all files", Session::stage_all)));
    app.on_unstage_all(with(|c| c.act("Unstaged all files", Session::unstage_all)));
    app.on_close_diff(with(|c| {
        c.act("", |s| {
            s.close_diff();
            Ok(())
        })
    }));
    app.on_toggle_file(with(|c| c.act("Done", Session::toggle_open_file)));
    app.on_apply_hunk(with_i(|c, h| c.act("Applied hunk", |s| s.apply_hunk(h as usize))));
    app.on_apply_lines(with(|c| {
        let app = c.app();
        let (a, b) = (app.get_sel_anchor(), app.get_sel_cursor());
        if a >= 0 && b >= 0 {
            c.act("Applied selected lines", |s| s.apply_lines(a as usize, b as usize));
        }
    }));
    app.on_selection_changed(with(|c| c.selection_changed()));
    app.on_copy_selection(with(|c| {
        let app = c.app();
        let (a, b) = (app.get_sel_anchor(), app.get_sel_cursor());
        let s = c.session.borrow();
        if let (Some(d), true) = (s.diff.as_ref(), a >= 0 && b >= 0) {
            let text = d.view.copy_text(a as usize, b as usize);
            let lines = text.lines().count();
            app.invoke_set_clipboard(text.into());
            app.set_status_text(format!("Copied {lines} line{}", if lines == 1 { "" } else { "s" }).into());
            app.set_status_error(false);
        }
    }));
    app.on_commit(with(|c| {
        let app = c.app();
        let (summary, description) = (app.get_summary().to_string(), app.get_description().to_string());
        if !c.session.borrow().can_commit(&summary) {
            return;
        }
        c.act("Committed", |s| s.commit(&summary, &description));
        if !app.get_status_error() {
            app.set_summary(SharedString::new());
            app.set_description(SharedString::new());
        }
    }));

    c.show_all();
    Ok((app, c))
}

impl Controller {
    /// For tests: the session behind the window.
    pub fn session(&self) -> std::cell::Ref<'_, Session> {
        self.session.borrow()
    }
}
