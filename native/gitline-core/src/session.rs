// The state and actions of the spike screen (history, staging, diff, commit box), independent of the
// toolkit. A front end calls these methods from its event handlers and redraws from the public fields.
use std::sync::Arc;

use crate::git::{Repo, Result};
use crate::highlight::ThemeKind;
use crate::types::*;
use crate::view::{DiffView, History};

/// The most commits the graph loads (the Electron app pages by 5,000; the spike loads them all at once
/// to show the list stays smooth).
pub const LOG_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileList {
    Unstaged,
    Staged,
    /// The files of the selected commit.
    Commit,
}

pub struct OpenDiff {
    pub list: FileList,
    pub file: FileChange,
    /// The commit shown, for a commit's file.
    pub sha: Option<String>,
    pub view: Arc<DiffView>,
    /// False until the highlighted view from `highlight_job` arrives.
    pub highlighted: bool,
    text: String,
    generation: u64,
}

impl OpenDiff {
    /// Whether hunks and lines can be staged (or unstaged) from this diff.
    pub fn can_apply(&self) -> bool {
        self.list != FileList::Commit && self.file.status != FileStatus::Untracked && self.view.can_apply()
    }
}

/// Highlighting a big diff takes long enough that it runs off the UI thread: the plain diff shows at
/// once and the highlighted one replaces it via `Session::finish_highlight`.
pub struct HighlightJob {
    pub generation: u64,
    text: String,
    path: String,
    theme: ThemeKind,
}

impl HighlightJob {
    pub fn run(self) -> (u64, DiffView) {
        (self.generation, DiffView::build(&self.text, &self.path, self.theme))
    }
}

pub struct Session {
    pub repo: Repo,
    pub info: RepoInfo,
    /// Shared so a UI's list model can hold it while the session moves on.
    pub history: Arc<History>,
    pub status: Status,
    /// Index into `history.commits`.
    pub selected: usize,
    pub details: Option<CommitDetails>,
    pub diff: Option<OpenDiff>,
    pub theme: ThemeKind,
    generation: u64,
}

impl Session {
    /// Opens the repository containing `path`.
    pub fn open(repo: Repo) -> Result<Session> {
        let top = repo.toplevel()?;
        let repo = repo.at(top);
        let info = repo.info()?;
        let mut s = Session {
            repo,
            info,
            history: Arc::new(History::build(Vec::new(), Vec::new(), None, None, false)),
            status: Status::default(),
            selected: 0,
            details: None,
            diff: None,
            theme: ThemeKind::Dark,
            generation: 0,
        };
        s.reload()?;
        s.select(0)?;
        Ok(s)
    }

    pub fn name(&self) -> String {
        self.repo.path.file_name().map_or_else(|| self.repo.path.display().to_string(), |n| n.to_string_lossy().into_owned())
    }

    /// The uncommitted-changes row's text, as the Electron app writes it: "3 uncommitted changes", and
    /// the first few file names ("· a.rs, b.rs, c.rs +2 more").
    pub fn wip_label(&self) -> (String, String) {
        let st = &self.status;
        let n = st.staged.len() + st.unstaged.len() + st.conflicted.len();
        let label = format!("{n} uncommitted change{}", if n == 1 { "" } else { "s" });
        let mut names: Vec<&str> = Vec::new();
        for f in st.conflicted.iter().chain(&st.unstaged).chain(&st.staged) {
            let name = crate::format::split_path(&f.path).1;
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let mut files = if names.is_empty() { String::new() } else { format!("· {}", names[..names.len().min(3)].join(", ")) };
        if names.len() > 3 {
            files.push_str(&format!(" +{} more", names.len() - 3));
        }
        (label, files)
    }

    pub fn wip_shown(&self) -> bool {
        self.history.commits.first().is_some_and(|c| c.sha == WIP)
    }

    pub fn wip_selected(&self) -> bool {
        self.wip_shown() && self.selected == 0
    }

    /// Re-reads everything from git, keeping the selected commit (by sha) and the open diff.
    pub fn reload(&mut self) -> Result<()> {
        let selected_sha = self.history.commits.get(self.selected).map(|c| c.sha.clone());
        self.info = self.repo.info()?;
        self.status = self.repo.status()?;
        let commits = self.repo.log(LOG_LIMIT, &GraphFilter::default())?;
        let refs = self.repo.refs()?;
        // The default branch keeps the leftmost lane of the graph.
        let trunk = ["main", "master", "origin/main", "origin/master"]
            .iter()
            .find_map(|n| refs.iter().find(|r| r.name == *n && r.kind != RefType::Tag))
            .map(|r| r.sha.clone());
        let wip = !self.status.is_clean() || self.info.state.is_some();
        let head = self.info.head.clone();
        let trunk = if wip && head.is_some() && head == trunk { Some(WIP.to_string()) } else { trunk };
        self.history = Arc::new(History::build(commits, refs, head.as_deref(), trunk.as_deref(), wip));
        self.selected = selected_sha.and_then(|s| self.history.commits.iter().position(|c| c.sha == s)).unwrap_or(0);
        self.refresh_diff()
    }

    pub fn select(&mut self, i: usize) -> Result<()> {
        if i >= self.history.commits.len() {
            return Ok(());
        }
        self.selected = i;
        self.diff = None;
        self.details = if self.wip_selected() { None } else { Some(self.repo.commit_details(&self.history.commits[i].sha)?) };
        Ok(())
    }

    pub fn files(&self, list: FileList) -> &[FileChange] {
        match list {
            FileList::Unstaged => &self.status.unstaged,
            FileList::Staged => &self.status.staged,
            FileList::Commit => self.details.as_ref().map_or(&[], |d| &d.files),
        }
    }

    pub fn open_file(&mut self, list: FileList, i: usize) -> Result<()> {
        let Some(file) = self.files(list).get(i).cloned() else { return Ok(()) };
        let (text, sha) = match list {
            FileList::Commit => {
                let sha = self.details.as_ref().map(|d| d.sha.clone()).unwrap_or_default();
                (self.repo.diff_commit(&sha, &file.path, file.old_path.as_deref(), None, false)?, Some(sha))
            }
            _ => (
                self.repo.diff_working(
                    &file.path,
                    list == FileList::Staged,
                    file.status == FileStatus::Untracked,
                    file.old_path.as_deref(),
                    false,
                )?,
                None,
            ),
        };
        self.generation += 1;
        self.diff = Some(OpenDiff {
            list,
            file,
            sha,
            view: Arc::new(DiffView::build_plain(&text)),
            highlighted: false,
            text,
            generation: self.generation,
        });
        Ok(())
    }

    pub fn close_diff(&mut self) {
        self.diff = None;
    }

    /// The highlighting still to do for the open diff, if any.
    pub fn highlight_job(&self) -> Option<HighlightJob> {
        let d = self.diff.as_ref().filter(|d| !d.highlighted)?;
        Some(HighlightJob { generation: d.generation, text: d.text.clone(), path: d.file.path.clone(), theme: self.theme })
    }

    /// Takes a finished highlight. Returns false (and drops it) if another diff was opened since.
    pub fn finish_highlight(&mut self, generation: u64, view: DiffView) -> bool {
        match self.diff.as_mut() {
            Some(d) if d.generation == generation && view.rows.len() == d.view.rows.len() => {
                d.view = Arc::new(view);
                d.highlighted = true;
                true
            }
            _ => false,
        }
    }

    /// After a change: reopens the diff that was open, from the list the file is in now.
    fn refresh_diff(&mut self) -> Result<()> {
        let Some(d) = self.diff.as_ref() else { return Ok(()) };
        if d.list == FileList::Commit {
            return Ok(());
        }
        let (path, list) = (d.file.path.clone(), d.list);
        let other = if list == FileList::Staged { FileList::Unstaged } else { FileList::Staged };
        for l in [list, other] {
            if let Some(i) = self.files(l).iter().position(|f| f.path == path) {
                return self.open_file(l, i);
            }
        }
        self.diff = None;
        Ok(())
    }

    // ---- actions; each one reloads afterwards ----

    pub fn stage_file(&mut self, i: usize) -> Result<()> {
        let Some(f) = self.status.unstaged.get(i).cloned() else { return Ok(()) };
        self.repo.stage(&[&f.path])?;
        self.reload()
    }

    pub fn unstage_file(&mut self, i: usize) -> Result<()> {
        let Some(f) = self.status.staged.get(i).cloned() else { return Ok(()) };
        let mut paths = vec![f.path.as_str()];
        paths.extend(f.old_path.as_deref());
        self.repo.unstage(&paths)?;
        self.reload()
    }

    pub fn stage_all(&mut self) -> Result<()> {
        self.repo.stage_all()?;
        self.reload()
    }

    pub fn unstage_all(&mut self) -> Result<()> {
        self.repo.unstage_all()?;
        self.reload()
    }

    /// Stages (from the unstaged diff) or unstages (from the staged diff) the whole open file.
    pub fn toggle_open_file(&mut self) -> Result<()> {
        let Some(d) = self.diff.as_ref() else { return Ok(()) };
        let mut paths = vec![d.file.path.clone()];
        paths.extend(d.file.old_path.clone());
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        match d.list {
            FileList::Unstaged => self.repo.stage(&paths)?,
            FileList::Staged => self.repo.unstage(&paths)?,
            FileList::Commit => return Ok(()),
        }
        self.reload()
    }

    /// Stages hunk `h` of the unstaged diff, or unstages it from the staged diff.
    pub fn apply_hunk(&mut self, h: usize) -> Result<()> {
        let Some(d) = self.diff.as_ref().filter(|d| d.can_apply()) else { return Ok(()) };
        if h >= d.view.parsed.hunks.len() {
            return Ok(());
        }
        self.repo.apply_patch(&d.view.hunk_patch(h), true, d.list == FileList::Staged)?;
        self.reload()
    }

    /// Stages (or unstages) just the change lines among rows `first..=last` of the open diff.
    pub fn apply_lines(&mut self, first: usize, last: usize) -> Result<()> {
        let Some(d) = self.diff.as_ref().filter(|d| d.can_apply()) else { return Ok(()) };
        let reverse = d.list == FileList::Staged;
        let Some(patch) = d.view.lines_patch(first.min(last)..=first.max(last), reverse) else { return Ok(()) };
        self.repo.apply_patch(&patch, true, reverse)?;
        self.reload()
    }

    pub fn can_commit(&self, summary: &str) -> bool {
        !summary.trim().is_empty() && !self.status.staged.is_empty()
    }

    pub fn commit(&mut self, summary: &str, description: &str) -> Result<()> {
        self.repo.commit(summary.trim(), description, false)?;
        self.diff = None;
        self.reload()?;
        self.select(self.selected)
    }
}
