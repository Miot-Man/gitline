// Temporary repos for the integration tests, like tests/helpers.ts. Git is pointed at tests/gitconfig
// (a copy of the Electron suite's) through each Repo's own environment, so results don't depend on the
// machine's config and tests can run in parallel.
#![allow(dead_code)]
use std::path::{Path, PathBuf};

use gitline_core::Repo;
use tempfile::TempDir;

pub struct TmpRepo {
    pub repo: Repo,
    // Removed when the test ends.
    _dir: TempDir,
}

impl std::ops::Deref for TmpRepo {
    type Target = Repo;
    fn deref(&self) -> &Repo {
        &self.repo
    }
}

fn gitconfig() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("gitconfig")
}

pub fn isolated(path: impl Into<PathBuf>) -> Repo {
    Repo::new(path).with_env("GIT_CONFIG_GLOBAL", gitconfig()).with_env("GIT_CONFIG_NOSYSTEM", "1")
}

/// An empty folder (not a repo).
pub fn tmp_dir() -> TmpRepo {
    let dir = tempfile::Builder::new().prefix("gitline-test-").tempdir().unwrap();
    TmpRepo { repo: isolated(dir.path()), _dir: dir }
}

pub fn tmp_repo() -> TmpRepo {
    let t = tmp_dir();
    t.init().unwrap();
    t
}

pub fn write(repo: &Repo, file: &str, content: &str) {
    let p = repo.path.join(file);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

pub fn read(repo: &Repo, file: &str) -> String {
    std::fs::read_to_string(repo.path.join(file)).unwrap()
}

/// Runs git and returns its trimmed output.
pub fn sh(repo: &Repo, args: &[&str]) -> String {
    repo.git(args).unwrap().stdout.trim().to_string()
}

pub fn commit_all(repo: &Repo, message: &str) -> String {
    repo.stage_all().unwrap();
    repo.commit(message, "", false).unwrap();
    sh(repo, &["rev-parse", "HEAD"])
}

pub fn subjects(repo: &Repo) -> Vec<String> {
    sh(repo, &["log", "--format=%s"]).lines().map(str::to_string).collect()
}
