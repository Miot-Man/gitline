// The spike screen's flow, driven through Session as the front ends drive it.
mod common;

use common::*;
use gitline_core::session::{FileList, Session};
use gitline_core::view::RowKind;

fn repo_with_changes() -> TmpRepo {
    let r = tmp_repo();
    write(&r, "f.rs", "fn a() {}\nfn b() {}\nfn c() {}\n");
    write(&r, "g.txt", "g\n");
    commit_all(&r, "first");
    r.create_branch("feature", None, false).unwrap();
    write(&r, "f.rs", "fn a() {}\nfn b2() {}\nfn c() {}\nfn d() {}\n");
    write(&r, "new.txt", "new\n");
    r
}

#[test]
fn opens_with_the_uncommitted_changes_selected() {
    let r = repo_with_changes();
    let s = Session::open(r.at(r.path.join("."))).unwrap();
    assert!(s.wip_selected());
    assert_eq!(s.history.commits.len(), 2);
    assert_eq!(s.files(FileList::Unstaged).len(), 2);
    assert_eq!(
        s.history.pills(1, s.info.head.as_deref(), false).iter().map(|p| p.label.as_str()).collect::<Vec<_>>(),
        vec!["main", "feature"]
    );
    // The WIP row takes the trunk's lane when main is checked out.
    assert_eq!(s.history.graph.rows[0].col, 0);
}

#[test]
fn opens_a_clean_repo_on_its_head_commit() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    commit_all(&r, "only");
    let s = Session::open(r.at(&r.path)).unwrap();
    assert!(!s.wip_shown());
    assert_eq!(s.details.as_ref().unwrap().message, "only");
}

#[test]
fn stages_lines_and_hunks_from_the_open_diff_then_commits() {
    let r = repo_with_changes();
    let mut s = Session::open(r.at(&r.path)).unwrap();
    let f = s.files(FileList::Unstaged).iter().position(|f| f.path == "f.rs").unwrap();
    s.open_file(FileList::Unstaged, f).unwrap();
    let d = s.diff.as_ref().unwrap();
    assert!(d.can_apply() && !d.highlighted);
    // Highlighting runs as a job and lands on the same diff.
    let (generation, view) = s.highlight_job().unwrap().run();
    assert!(s.finish_highlight(generation, view));
    assert!(s.highlight_job().is_none());

    // Stage only "fn d() {}".
    let rows = &s.diff.as_ref().unwrap().view.rows;
    let d_row = rows.iter().position(|x| x.kind == RowKind::Add && x.text == "fn d() {}").unwrap();
    s.apply_lines(d_row, d_row).unwrap();
    assert_eq!(sh(&r, &["show", ":f.rs"]), "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}");
    // The diff reopened on the unstaged side, without the staged line.
    let d = s.diff.as_ref().unwrap();
    assert_eq!(d.list, FileList::Unstaged);
    assert!(!d.view.rows.iter().any(|x| x.text == "fn d() {}" && x.kind == RowKind::Add));

    // Stage the rest of the file as a hunk, then unstage that hunk from the staged side.
    s.apply_hunk(0).unwrap();
    assert_eq!(s.diff.as_ref().unwrap().list, FileList::Staged);
    assert!(s.files(FileList::Unstaged).iter().all(|f| f.path != "f.rs"));
    s.apply_hunk(0).unwrap();
    assert_eq!(sh(&r, &["show", ":f.rs"]), "fn a() {}\nfn b() {}\nfn c() {}");

    // Whole files, then commit.
    s.stage_all().unwrap();
    assert_eq!(s.files(FileList::Staged).len(), 2);
    let i = s.files(FileList::Staged).iter().position(|f| f.path == "new.txt").unwrap();
    s.unstage_file(i).unwrap();
    assert!(!s.can_commit("  "));
    assert!(s.can_commit("Add d"));
    s.commit("Add d", "Body").unwrap();
    assert_eq!(sh(&r, &["log", "-1", "--format=%B"]), "Add d\n\nBody");
    assert!(s.wip_selected(), "new.txt is still untracked");
    assert_eq!(s.history.commits[1].subject, "Add d");
    let u = s.files(FileList::Unstaged).iter().position(|f| f.path == "new.txt").unwrap();
    s.stage_file(u).unwrap();
    s.commit("Add new", "").unwrap();
    assert!(!s.wip_shown());
    assert_eq!(s.details.as_ref().unwrap().message, "Add new");
}

#[test]
fn shows_a_commits_files_and_their_diffs() {
    let r = repo_with_changes();
    let mut s = Session::open(r.at(&r.path)).unwrap();
    s.select(1).unwrap();
    assert_eq!(s.details.as_ref().unwrap().files.len(), 2);
    s.open_file(FileList::Commit, 0).unwrap();
    let d = s.diff.as_ref().unwrap();
    assert!(!d.can_apply(), "a commit's diff is read-only");
    assert!(d.view.rows.iter().any(|x| x.kind == RowKind::Add));
    // A stale highlight (for a diff that's since been replaced) is dropped.
    let job = s.highlight_job().unwrap();
    s.open_file(FileList::Commit, 1).unwrap();
    let (generation, view) = job.run();
    assert!(!s.finish_highlight(generation, view));
}

#[test]
fn refuses_a_folder_that_is_not_a_repo() {
    assert!(Session::open(tmp_dir().repo.clone()).is_err());
}
