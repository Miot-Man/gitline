// Typed results of the git ops, modelled on src/types.ts in the Electron app.

/// The pseudo-sha the graph uses for the "uncommitted changes" row, as in the Electron app.
pub const WIP: &str = "__WIP__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefType {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ref {
    pub full: String,
    pub name: String,
    pub kind: RefType,
    pub remote: Option<String>,
    pub sha: String,
    pub upstream: Option<String>,
    /// `ahead 1, behind 2`, `gone`, ... as git prints it.
    pub track: Option<String>,
    pub is_head: bool,
}

/// One letter of `git status` / `--name-status`: M A D R C U ? T.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Conflicted,
    Untracked,
    TypeChanged,
}

impl FileStatus {
    pub fn from_char(c: char) -> FileStatus {
        match c {
            'A' => FileStatus::Added,
            'D' => FileStatus::Deleted,
            'R' => FileStatus::Renamed,
            'C' => FileStatus::Copied,
            'U' => FileStatus::Conflicted,
            '?' => FileStatus::Untracked,
            'T' => FileStatus::TypeChanged,
            _ => FileStatus::Modified,
        }
    }

    pub fn as_char(self) -> char {
        match self {
            FileStatus::Modified => 'M',
            FileStatus::Added => 'A',
            FileStatus::Deleted => 'D',
            FileStatus::Renamed => 'R',
            FileStatus::Copied => 'C',
            FileStatus::Conflicted => 'U',
            FileStatus::Untracked => '?',
            FileStatus::TypeChanged => 'T',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
}

impl FileChange {
    pub fn new(path: &str, status: FileStatus) -> FileChange {
        FileChange { path: path.to_string(), old_path: None, status }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

impl Status {
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoState {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RepoInfo {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub state: Option<RepoState>,
    pub merge_msg: Option<String>,
    pub remotes: Vec<String>,
    /// Milliseconds since the epoch of the last fetch/pull, if any.
    pub fetched_at: Option<f64>,
    pub bisecting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitDetails {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<FileChange>,
}

/// The result of an op that may stop on conflicts (merge, rebase, cherry-pick, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpResult {
    pub conflict: bool,
    pub output: String,
}

/// `solo` limits the graph to those refs (plus HEAD); `hidden` drops refs from `--all`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphFilter {
    pub solo: Vec<String>,
    pub hidden: Vec<String>,
}
