// Thin wrapper around the git CLI, ported from electron/git.cjs. Every op runs `git` as a child
// process with the same arguments and environment as the Electron app, so behaviour stays identical.
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::types::*;

const SEP: char = '\x1f';
const REC: char = '\x1e';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error("git was not found. Install it and make sure it is on your PATH.".into())
        } else {
            Error(e.to_string())
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// What a git run produced. `code` is the exit code (1 if git was killed by a signal).
#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[derive(Default)]
struct Opts<'a> {
    allow_fail: bool,
    input: Option<&'a [u8]>,
    /// Leave out the `-c core.quotepath=false -c color.ui=false` prefix (as gitInput does).
    bare: bool,
}

/// A repository (or any folder, for `init`), plus extra environment for every git it runs.
/// The extra environment is how tests point git at their own global config without touching the
/// process environment, which would leak between tests running in parallel.
#[derive(Debug, Clone)]
pub struct Repo {
    pub path: PathBuf,
    env: Vec<(OsString, OsString)>,
}

/// Builds a git command with the environment git.cjs sets.
pub fn command(cwd: &Path, args: &[&OsStr], env: &[(OsString, OsString)]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .envs(env.iter().map(|(k, v)| (k, v)));
    hide_window(&mut cmd);
    cmd
}

/// On Windows a console program otherwise flashes a console window, which also takes focus.
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

fn lines(s: &str) -> impl Iterator<Item = &str> {
    s.split('\n').filter(|l| !l.is_empty())
}

fn split_parents(p: &str) -> Vec<String> {
    p.split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

fn parse_time(t: &str) -> i64 {
    t.trim().parse().unwrap_or(0)
}

/// Parses `--name-status -z` output.
pub fn parse_name_status(out: &str) -> Vec<FileChange> {
    let t: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < t.len() && !t[i].is_empty() {
        let status = t[i].chars().next().unwrap_or('M');
        if status == 'R' || status == 'C' {
            files.push(FileChange {
                status: FileStatus::from_char(status),
                old_path: t.get(i + 1).map(|s| s.to_string()),
                path: t.get(i + 2).unwrap_or(&"").to_string(),
            });
            i += 3;
        } else {
            files.push(FileChange::new(t.get(i + 1).unwrap_or(&""), FileStatus::from_char(status)));
            i += 2;
        }
    }
    files
}

impl Repo {
    pub fn new(path: impl Into<PathBuf>) -> Repo {
        Repo { path: path.into(), env: Vec::new() }
    }

    /// Adds an environment variable to every git this repo runs.
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Repo {
        self.env.push((key.into(), value.into()));
        self
    }

    /// The same environment, for another folder.
    pub fn at(&self, path: impl Into<PathBuf>) -> Repo {
        Repo { path: path.into(), env: self.env.clone() }
    }

    fn run(&self, args: &[&str], opts: Opts) -> Result<Output> {
        let mut full: Vec<&OsStr> = Vec::with_capacity(args.len() + 4);
        if !opts.bare {
            full.extend(["-c", "core.quotepath=false", "-c", "color.ui=false"].map(OsStr::new));
        }
        full.extend(args.iter().map(OsStr::new));
        let mut cmd = command(&self.path, &full, &self.env);
        cmd.stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn()?;
        if let Some(input) = opts.input {
            // Write on another thread so a large patch can't deadlock against a full stdout pipe.
            let mut stdin = child.stdin.take().expect("piped stdin");
            let data = input.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            });
        }
        let out = child.wait_with_output()?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let code = out.status.code().unwrap_or(1);
        if code != 0 && !opts.allow_fail {
            let msg = if !stderr.trim().is_empty() { &stderr } else { &stdout };
            let msg = msg.trim();
            return Err(Error(if msg.is_empty() { format!("git {} failed", args.join(" ")) } else { msg.to_string() }));
        }
        Ok(Output { stdout, stderr, code })
    }

    /// Runs git and fails on a non-zero exit, with git's own message.
    pub fn git(&self, args: &[&str]) -> Result<Output> {
        self.run(args, Opts::default())
    }

    /// Runs git and reports the exit code instead of failing.
    pub fn git_allow_fail(&self, args: &[&str]) -> Result<Output> {
        self.run(args, Opts { allow_fail: true, ..Default::default() })
    }

    fn git_input(&self, args: &[&str], input: &[u8]) -> Result<Output> {
        self.run(args, Opts { input: Some(input), bare: true, ..Default::default() })
    }

    fn has_head(&self) -> Result<bool> {
        Ok(self.git_allow_fail(&["rev-parse", "--verify", "-q", "HEAD"])?.code == 0)
    }

    /// Runs an op that may stop on conflicts: a conflict is reported as a state, not an error.
    fn conflict_aware(&self, args: &[&str]) -> Result<OpResult> {
        let r = self.git_allow_fail(args)?;
        let text = format!("{}{}", r.stdout, r.stderr);
        let output = text.trim().to_string();
        if r.code == 0 {
            return Ok(OpResult { conflict: false, output });
        }
        let lower = text.to_lowercase();
        if text.contains("CONFLICT") || lower.contains("could not apply") || lower.contains("after resolving the conflicts") {
            return Ok(OpResult { conflict: true, output });
        }
        Err(Error(output))
    }

    // ---- repository ----

    /// The top folder of the work tree that contains `path`.
    pub fn toplevel(&self) -> Result<PathBuf> {
        Ok(PathBuf::from(self.git(&["rev-parse", "--show-toplevel"])?.stdout.trim()))
    }

    /// Creates the folder if needed and runs `git init` in it.
    pub fn init(&self) -> Result<()> {
        std::fs::create_dir_all(&self.path)?;
        self.git(&["init", "-q"])?;
        Ok(())
    }

    pub fn info(&self) -> Result<RepoInfo> {
        let head = self.git_allow_fail(&["rev-parse", "--verify", "-q", "HEAD"])?;
        let branch = self.git_allow_fail(&["symbolic-ref", "--short", "-q", "HEAD"])?;
        let git_dir = PathBuf::from(self.git(&["rev-parse", "--absolute-git-dir"])?.stdout.trim());
        let remotes = self.git(&["remote"])?;
        let exists = |name: &str| git_dir.join(name).exists();

        let bisecting = exists("BISECT_LOG");
        let state = if exists("rebase-merge") || exists("rebase-apply") {
            Some(RepoState::Rebase)
        } else if exists("MERGE_HEAD") {
            Some(RepoState::Merge)
        } else if exists("CHERRY_PICK_HEAD") {
            Some(RepoState::CherryPick)
        } else if exists("REVERT_HEAD") {
            Some(RepoState::Revert)
        } else {
            None
        };
        let merge_msg = match state {
            Some(s) if s != RepoState::Rebase => std::fs::read_to_string(git_dir.join("MERGE_MSG"))
                .ok()
                .map(|m| m.split('\n').filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string()),
            _ => None,
        };
        // FETCH_HEAD is rewritten on every fetch/pull, so its mtime is when the repo last talked to a remote.
        let fetched_at = std::fs::metadata(git_dir.join("FETCH_HEAD"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0);
        let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
        Ok(RepoInfo {
            head: non_empty(&head.stdout),
            branch: non_empty(&branch.stdout),
            state,
            merge_msg,
            remotes: lines(&remotes.stdout).map(str::to_string).collect(),
            fetched_at,
            bisecting,
        })
    }

    // ---- history ----

    pub fn log(&self, limit: usize, filter: &GraphFilter) -> Result<Vec<Commit>> {
        let fmt = format!("--pretty=format:{}%x1e", ["%H", "%P", "%an", "%ae", "%at", "%s"].join("%x1f"));
        let limit = limit.to_string();
        let excludes: Vec<String> = filter.hidden.iter().map(|h| format!("--exclude={h}")).collect();
        let mut args: Vec<&str> = vec!["log"];
        if !filter.solo.is_empty() {
            args.push("--ignore-missing");
            args.extend(filter.solo.iter().map(String::as_str));
            args.push("HEAD");
        } else {
            args.extend(excludes.iter().map(String::as_str));
            args.extend(["--exclude=refs/stash", "--all"]);
        }
        args.extend(["--date-order", "-n", &limit, &fmt, "--"]);
        let r = self.git_allow_fail(&args)?;
        if r.code != 0 {
            return Ok(Vec::new());
        }
        Ok(r.stdout
            .split(REC)
            .map(|s| s.strip_prefix('\n').unwrap_or(s))
            .filter(|s| !s.is_empty())
            .map(|s| {
                let f: Vec<&str> = s.split(SEP).collect();
                let get = |i: usize| f.get(i).copied().unwrap_or("");
                Commit {
                    sha: get(0).to_string(),
                    parents: split_parents(get(1)),
                    author: get(2).to_string(),
                    email: get(3).to_string(),
                    time: parse_time(get(4)),
                    subject: get(5).to_string(),
                }
            })
            .collect())
    }

    pub fn refs(&self) -> Result<Vec<Ref>> {
        let fmt =
            ["%(refname)", "%(objectname)", "%(*objectname)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(HEAD)"].join("%1f");
        let r = self.git(&["for-each-ref", &format!("--format={fmt}"), "refs/heads", "refs/remotes", "refs/tags"])?;
        let opt = |s: &str| Some(s.to_string()).filter(|s| !s.is_empty());
        Ok(lines(&r.stdout)
            .filter_map(|l| {
                let f: Vec<&str> = l.split(SEP).collect();
                let get = |i: usize| f.get(i).copied().unwrap_or("");
                let full = get(0);
                let (kind, name, remote) = if let Some(n) = full.strip_prefix("refs/heads/") {
                    (RefType::Local, n, None)
                } else if let Some(n) = full.strip_prefix("refs/remotes/") {
                    (RefType::Remote, n, n.split('/').next().map(str::to_string))
                } else {
                    (RefType::Tag, full.strip_prefix("refs/tags/").unwrap_or(full), None)
                };
                // origin/HEAD and bare remote names aren't branches.
                if kind == RefType::Remote && (name.ends_with("/HEAD") || !name.contains('/')) {
                    return None;
                }
                Some(Ref {
                    full: full.to_string(),
                    name: name.to_string(),
                    kind,
                    remote,
                    sha: opt(get(2)).unwrap_or_else(|| get(1).to_string()),
                    upstream: opt(get(3)),
                    track: opt(get(4)),
                    is_head: get(5) == "*",
                })
            })
            .collect())
    }

    pub fn stashes(&self) -> Result<Vec<Stash>> {
        let r = self.git_allow_fail(&["stash", "list", "--format=%gd%x1f%H%x1f%s"])?;
        Ok(lines(&r.stdout)
            .map(|l| {
                let f: Vec<&str> = l.split(SEP).collect();
                let get = |i: usize| f.get(i).copied().unwrap_or("");
                let r#ref = get(0).to_string();
                let index = r#ref.split_once('{').and_then(|(_, n)| n.trim_end_matches('}').parse().ok()).unwrap_or(0);
                Stash { r#ref, sha: get(1).to_string(), message: get(2).to_string(), index }
            })
            .collect())
    }

    pub fn commit_details(&self, sha: &str) -> Result<CommitDetails> {
        let r = self.git(&["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", sha])?;
        let f: Vec<&str> = r.stdout.splitn(9, SEP).collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        let parents = split_parents(get(1));
        let files = if let Some(first) = parents.first() {
            self.git(&["diff", "--name-status", "-z", "-M", first, sha])?
        } else {
            self.git(&["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", "-M", sha])?
        };
        Ok(CommitDetails {
            sha: get(0).to_string(),
            parents,
            author: get(2).to_string(),
            email: get(3).to_string(),
            time: parse_time(get(4)),
            committer: get(5).to_string(),
            committer_email: get(6).to_string(),
            commit_time: parse_time(get(7)),
            message: get(8).trim_end().to_string(),
            files: parse_name_status(&files.stdout),
        })
    }

    // ---- working tree ----

    pub fn status(&self) -> Result<Status> {
        let r = self.git(&["status", "--porcelain=v1", "-z", "-uall"])?;
        let parts: Vec<&str> = r.stdout.split('\0').collect();
        let mut s = Status::default();
        let mut i = 0;
        while i < parts.len() {
            let e = parts[i];
            i += 1;
            if e.len() < 4 {
                continue;
            }
            let x = e.as_bytes()[0] as char;
            let y = e.as_bytes()[1] as char;
            let p = &e[3..];
            let mut old_path = None;
            if x == 'R' || x == 'C' {
                old_path = parts.get(i).map(|s| s.to_string());
                i += 1;
            }
            match (x, y) {
                ('!', '!') => continue,
                ('?', '?') => s.unstaged.push(FileChange::new(p, FileStatus::Untracked)),
                ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U') => {
                    s.conflicted.push(FileChange::new(p, FileStatus::Conflicted))
                }
                _ => {
                    if x != ' ' {
                        s.staged.push(FileChange { path: p.to_string(), old_path, status: FileStatus::from_char(x) });
                    }
                    if y != ' ' {
                        s.unstaged.push(FileChange::new(p, FileStatus::from_char(y)));
                    }
                }
            }
        }
        Ok(s)
    }

    /// Ignored files; an ignored folder is listed once (`build/`) instead of every file inside it.
    pub fn ignored_files(&self) -> Result<Vec<String>> {
        let r = self.git(&["status", "--porcelain=v1", "-z", "--ignored=traditional", "-unormal"])?;
        Ok(r.stdout.split('\0').filter_map(|e| e.strip_prefix("!! ")).map(str::to_string).collect())
    }

    /// The diff of one file in the work tree (or the index, when `staged`). `ignore_ws` hides
    /// whitespace-only changes (git diff -w); such diffs can't be applied back as patches.
    pub fn diff_working(&self, file: &str, staged: bool, untracked: bool, old_path: Option<&str>, ignore_ws: bool) -> Result<String> {
        if untracked {
            return Ok(self.git_allow_fail(&["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", file])?.stdout);
        }
        let mut args = vec!["diff", "--no-ext-diff", "-M"];
        if ignore_ws {
            args.push("-w");
        }
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.extend(old_path);
        args.push(file);
        Ok(self.git(&args)?.stdout)
    }

    /// The diff of one file in a commit, against `parent` when given (for merges), else its first parent.
    pub fn diff_commit(&self, sha: &str, file: &str, old_path: Option<&str>, parent: Option<&str>, ignore_ws: bool) -> Result<String> {
        let mut args: Vec<&str> = Vec::new();
        match parent {
            Some(p) => args.extend(["diff", "--no-ext-diff", "-M"].iter().chain(ignore_ws.then_some(&"-w")).chain([&p, &sha])),
            None => args.extend(["show", "--no-ext-diff", "--format=", "-M"].iter().chain(ignore_ws.then_some(&"-w")).chain([&sha])),
        }
        args.push("--");
        args.extend(old_path);
        args.push(file);
        Ok(self.git(&args)?.stdout)
    }

    pub fn stage(&self, paths: &[&str]) -> Result<()> {
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths);
        self.git(&args).map(drop)
    }

    pub fn stage_all(&self) -> Result<()> {
        self.git(&["add", "-A"]).map(drop)
    }

    pub fn unstage(&self, paths: &[&str]) -> Result<()> {
        let mut args = if self.has_head()? { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--"] };
        args.extend(paths);
        self.git(&args).map(drop)
    }

    pub fn unstage_all(&self) -> Result<()> {
        if self.has_head()? { self.git(&["reset", "-q"]).map(drop) } else { self.git(&["rm", "--cached", "-r", "-q", "."]).map(drop) }
    }

    /// Applies a patch to the index (`cached`) or the work tree. `--recount`: line-level patches are
    /// built without exact hunk header counts.
    pub fn apply_patch(&self, patch: &str, cached: bool, reverse: bool) -> Result<()> {
        let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
        if cached {
            args.push("--cached");
        }
        if reverse {
            args.push("--reverse");
        }
        args.push("-");
        self.git_input(&args, patch.as_bytes()).map(drop)
    }

    pub fn commit(&self, summary: &str, description: &str, amend: bool) -> Result<()> {
        let mut args = vec!["commit", "-q", "-m", summary];
        let description = description.trim();
        if !description.is_empty() {
            args.extend(["-m", description]);
        }
        if amend {
            args.push("--amend");
        }
        self.git(&args).map(drop)
    }

    // ---- branches and conflict-aware ops (the rest of git.cjs is ported after the spike) ----

    pub fn checkout(&self, rev: &str) -> Result<()> {
        self.git(&["checkout", "-q", rev]).map(drop)
    }

    pub fn create_branch(&self, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
        let mut args = if checkout { vec!["checkout", "-q", "-b", name] } else { vec!["branch", name] };
        args.extend(start);
        self.git(&args).map(drop)
    }

    pub fn merge(&self, rev: &str) -> Result<OpResult> {
        self.conflict_aware(&["merge", "--no-edit", rev])
    }

    pub fn rebase(&self, onto: &str) -> Result<OpResult> {
        self.conflict_aware(&["rebase", onto])
    }

    pub fn cherry_pick(&self, sha: &str) -> Result<OpResult> {
        self.conflict_aware(&["cherry-pick", sha])
    }

    pub fn revert(&self, sha: &str, is_merge: bool) -> Result<OpResult> {
        if is_merge {
            self.conflict_aware(&["revert", "--no-edit", "-m", "1", sha])
        } else {
            self.conflict_aware(&["revert", "--no-edit", sha])
        }
    }

    /// `stash_ref` is e.g. `stash@{1}`.
    pub fn stash_apply(&self, stash_ref: &str) -> Result<OpResult> {
        self.conflict_aware(&["stash", "apply", stash_ref])
    }

    pub fn stash_pop(&self, stash_ref: Option<&str>) -> Result<OpResult> {
        let mut args = vec!["stash", "pop"];
        args.extend(stash_ref);
        self.conflict_aware(&args)
    }
}
