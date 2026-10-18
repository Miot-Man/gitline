// Ported from tests/git-ops.test.ts: the cases for the ops the spike screens use.
mod common;

use std::collections::HashSet;

use common::*;
use gitline_core::diff::{LineKind, build_line_patch, parse_diff};
use gitline_core::*;

fn fc(path: &str, status: FileStatus) -> FileChange {
    FileChange::new(path, status)
}

#[test]
fn stages_commits_and_reports_status() {
    let r = tmp_repo();
    write(&r, "a.txt", "one\n");
    assert_eq!(r.status().unwrap().unstaged, vec![fc("a.txt", FileStatus::Untracked)]);
    r.stage(&["a.txt"]).unwrap();
    assert_eq!(r.status().unwrap().staged, vec![fc("a.txt", FileStatus::Added)]);
    r.commit("Add a", "Body text", false).unwrap();
    assert_eq!(sh(&r, &["log", "-1", "--format=%B"]), "Add a\n\nBody text");
    let info = r.info().unwrap();
    assert_eq!(info.branch.as_deref(), Some("main"));
    assert_eq!(info.head.as_deref(), Some(sh(&r, &["rev-parse", "HEAD"]).as_str()));
    assert_eq!(info.state, None);
    assert!(r.status().unwrap().is_clean());
}

#[test]
fn finds_the_top_of_the_work_tree() {
    let r = tmp_repo();
    write(&r, "sub/dir/f", "x\n");
    let top = r.at(r.path.join("sub/dir")).toplevel().unwrap();
    assert_eq!(std::fs::canonicalize(top).unwrap(), std::fs::canonicalize(&r.path).unwrap());
    assert!(tmp_dir().toplevel().is_err());
}

#[test]
fn shows_untracked_files_as_a_diff() {
    let r = tmp_repo();
    write(&r, "new.txt", "hello\n");
    assert!(r.diff_working("new.txt", false, true, None, false).unwrap().contains("+hello"));
}

#[test]
fn unstages_in_a_repo_without_commits() {
    let r = tmp_repo();
    write(&r, "a", "1\n");
    write(&r, "b", "1\n");
    r.stage_all().unwrap();
    r.unstage(&["a"]).unwrap();
    assert_eq!(r.status().unwrap().staged, vec![fc("b", FileStatus::Added)]);
    r.unstage_all().unwrap();
    assert!(r.status().unwrap().staged.is_empty());
}

#[test]
fn stages_and_unstages_whole_files_after_the_first_commit() {
    let r = tmp_repo();
    write(&r, "a", "1\n");
    write(&r, "b", "1\n");
    commit_all(&r, "init");
    write(&r, "a", "2\n");
    std::fs::remove_file(r.path.join("b")).unwrap();
    r.stage_all().unwrap();
    assert_eq!(r.status().unwrap().staged, vec![fc("a", FileStatus::Modified), fc("b", FileStatus::Deleted)]);
    r.unstage(&["b"]).unwrap();
    let s = r.status().unwrap();
    assert_eq!(s.staged, vec![fc("a", FileStatus::Modified)]);
    assert_eq!(s.unstaged, vec![fc("b", FileStatus::Deleted)]);
    r.unstage_all().unwrap();
    assert_eq!(r.status().unwrap().unstaged.len(), 2);
}

#[test]
fn reports_renames_in_the_index() {
    let r = tmp_repo();
    write(&r, "old.txt", "a\nb\nc\n");
    commit_all(&r, "add");
    std::fs::rename(r.path.join("old.txt"), r.path.join("new.txt")).unwrap();
    r.stage_all().unwrap();
    let s = r.status().unwrap();
    assert_eq!(s.staged, vec![FileChange { path: "new.txt".into(), old_path: Some("old.txt".into()), status: FileStatus::Renamed }]);
    assert!(s.unstaged.is_empty());
}

#[test]
fn amends_the_last_commit() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    commit_all(&r, "first");
    write(&r, "g", "1\n");
    r.stage_all().unwrap();
    r.commit("first, amended", "", true).unwrap();
    assert_eq!(subjects(&r), vec!["first, amended"]);
    assert!(r.commit("", "", false).is_err(), "an empty message is refused by git");
}

// ---- line staging ----

#[test]
fn stages_unstages_and_discards_single_lines() {
    let r = tmp_repo();
    write(&r, "f", "a\nb\nc\nd\ne\n");
    commit_all(&r, "init");
    write(&r, "f", "a\nB\nc\nD\ne\nnew\n");
    let pick = |reverse: bool, staged: bool, lines: &[(&str, LineKind)]| {
        let d = parse_diff(&r.diff_working("f", staged, false, None, false).unwrap());
        let h = &d.hunks[0];
        let sel: HashSet<usize> = lines.iter().map(|(t, k)| h.lines.iter().position(|l| l.text == *t && l.kind == *k).unwrap()).collect();
        build_line_patch(&d.header, h, &sel, reverse)
    };
    r.apply_patch(&pick(false, false, &[("d", LineKind::Del), ("D", LineKind::Add)]), true, false).unwrap();
    assert_eq!(sh(&r, &["show", ":f"]), "a\nb\nc\nD\ne");
    r.apply_patch(&pick(true, true, &[("d", LineKind::Del), ("D", LineKind::Add)]), true, true).unwrap();
    assert_eq!(sh(&r, &["show", ":f"]), "a\nb\nc\nd\ne");
    r.apply_patch(&pick(true, false, &[("new", LineKind::Add)]), false, true).unwrap();
    assert_eq!(read(&r, "f"), "a\nB\nc\nD\ne\n");
}

#[test]
fn keeps_line_order_when_only_part_of_a_change_block_is_staged() {
    let r = tmp_repo();
    write(&r, "f", "x\ny\nz\n");
    commit_all(&r, "init");
    write(&r, "f", "X\nY\nz\n");
    let d = parse_diff(&r.diff_working("f", false, false, None, false).unwrap());
    let h = &d.hunks[0];
    let i = |t: &str| h.lines.iter().position(|l| l.text == t).unwrap();
    r.apply_patch(&build_line_patch(&d.header, h, &HashSet::from([i("y"), i("Y")]), false), true, false).unwrap();
    assert_eq!(sh(&r, &["show", ":f"]), "x\nY\nz");
}

#[test]
fn stages_a_whole_hunk_and_lines_from_the_view_model() {
    let r = tmp_repo();
    let body: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    write(&r, "f.txt", &body);
    commit_all(&r, "init");
    write(&r, "f.txt", &body.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n"));
    let v = view::DiffView::build(&r.diff_working("f.txt", false, false, None, false).unwrap(), "f.txt", highlight::ThemeKind::Dark);
    assert_eq!(v.parsed.hunks.len(), 2);
    r.apply_patch(&v.hunk_patch(1), true, false).unwrap();
    assert!(sh(&r, &["show", ":f.txt"]).contains("line twenty-eight"));
    assert!(!sh(&r, &["show", ":f.txt"]).contains("line two"));
    // Select just the added line of the first hunk.
    let add = v.rows.iter().position(|row| row.kind == view::RowKind::Add && row.text == "line two").unwrap();
    r.apply_patch(&v.lines_patch([add], false).unwrap(), true, false).unwrap();
    let staged = sh(&r, &["show", ":f.txt"]);
    assert!(staged.contains("line 2\nline two\nline 3"), "{staged}");
}

#[test]
fn reports_a_bad_patch_as_an_error() {
    let r = tmp_repo();
    write(&r, "f", "a\n");
    commit_all(&r, "init");
    let err = r.apply_patch("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-zzz\n+yyy\n", true, false).unwrap_err();
    assert!(err.0.contains("patch does not apply"), "{err}");
}

#[test]
fn hides_whitespace_only_changes_when_asked() {
    let r = tmp_repo();
    write(&r, "f.c", "int a = 1;\nint b = 2;\n");
    commit_all(&r, "init");
    write(&r, "f.c", "  int a = 1;\nint b = 3;\n");
    let all = r.diff_working("f.c", false, false, None, false).unwrap();
    let no_ws = r.diff_working("f.c", false, false, None, true).unwrap();
    assert!(all.contains("+  int a = 1;"));
    assert!(!no_ws.contains("+  int a = 1;"));
    assert!(no_ws.contains("+int b = 3;"));
}

// ---- history ----

#[test]
fn reads_the_log_and_filters_it() {
    let r = tmp_repo();
    write(&r, "src/config.ts", "export const apiToken = 1;\n");
    commit_all(&r, "config");
    write(&r, "readme.md", "hi\n");
    commit_all(&r, "readme");
    r.create_branch("side", None, true).unwrap();
    write(&r, "side.txt", "s\n");
    commit_all(&r, "side work");
    r.checkout("main").unwrap();
    let all = r.log(100, &GraphFilter::default()).unwrap();
    assert_eq!(all.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["side work", "readme", "config"]);
    assert_eq!(all[0].parents, vec![all[1].sha.clone()]);
    assert_eq!(all[0].author, "Test User");
    assert_eq!(all[0].email, "test@example.com");
    assert!(all[0].time > 1_600_000_000);
    assert!(all[2].parents.is_empty());
    let hidden = GraphFilter { hidden: vec!["refs/heads/side".into()], ..Default::default() };
    assert_eq!(r.log(100, &hidden).unwrap().len(), 2);
    let solo = GraphFilter { solo: vec!["refs/heads/side".into()], ..Default::default() };
    assert_eq!(r.log(100, &solo).unwrap().len(), 3);
    let missing = GraphFilter { solo: vec!["refs/heads/missing".into()], ..Default::default() };
    assert_eq!(r.log(100, &missing).unwrap().len(), 2);
    assert_eq!(r.log(1, &GraphFilter::default()).unwrap().len(), 1);
    // An empty repo has no log rather than an error.
    assert!(tmp_repo().log(100, &GraphFilter::default()).unwrap().is_empty());
}

#[test]
fn keeps_odd_characters_in_subjects_and_names() {
    let r = tmp_repo();
    write(&r, "dir with space/ünïcode.txt", "x\n");
    commit_all(&r, "subject | with \"quotes\" and ünïcode");
    let log = r.log(10, &GraphFilter::default()).unwrap();
    assert_eq!(log[0].subject, "subject | with \"quotes\" and ünïcode");
    let d = r.commit_details(&log[0].sha).unwrap();
    assert_eq!(d.files, vec![fc("dir with space/ünïcode.txt", FileStatus::Added)]);
}

#[test]
fn lists_branches_tags_and_remotes() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    let first = commit_all(&r, "first");
    sh(&r, &["tag", "-a", "v1", "-m", "Release one"]);
    sh(&r, &["tag", "light"]);
    let remote = tmp_dir();
    sh(&remote, &["init", "-q", "--bare"]);
    let url = remote.path.to_string_lossy().to_string();
    sh(&r, &["remote", "add", "origin", &url]);
    sh(&r, &["push", "-q", "-u", "origin", "main"]);
    write(&r, "f", "2\n");
    let second = commit_all(&r, "second");
    r.create_branch("feature", Some(&first), false).unwrap();

    let refs = r.refs().unwrap();
    let get = |full: &str| refs.iter().find(|x| x.full == full).unwrap_or_else(|| panic!("{full} in {refs:?}"));
    let main = get("refs/heads/main");
    assert_eq!((main.kind, main.name.as_str(), main.sha.as_str(), main.is_head), (RefType::Local, "main", second.as_str(), true));
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!(main.track.as_deref(), Some("ahead 1"));
    assert!(!get("refs/heads/feature").is_head);
    let om = get("refs/remotes/origin/main");
    assert_eq!((om.kind, om.remote.as_deref(), om.sha.as_str()), (RefType::Remote, Some("origin"), first.as_str()));
    // Annotated tags point at their commit, not the tag object.
    assert_eq!(get("refs/tags/v1").sha, first);
    assert_eq!(get("refs/tags/light").kind, RefType::Tag);
    assert_eq!(r.info().unwrap().remotes, vec!["origin"]);
}

#[test]
fn reads_commit_details_with_renames() {
    let r = tmp_repo();
    write(&r, "old.txt", "a\nb\nc\n");
    let root = commit_all(&r, "add");
    std::fs::rename(r.path.join("old.txt"), r.path.join("new.txt")).unwrap();
    write(&r, "other", "x\n");
    r.stage_all().unwrap();
    r.commit("rename", "with a body\n\nand two paragraphs", false).unwrap();
    let sha = sh(&r, &["rev-parse", "HEAD"]);
    let d = r.commit_details(&sha).unwrap();
    assert_eq!(d.sha, sha);
    assert_eq!(d.parents, vec![root.clone()]);
    assert_eq!(d.message, "rename\n\nwith a body\n\nand two paragraphs");
    assert_eq!((d.author.as_str(), d.committer_email.as_str()), ("Test User", "test@example.com"));
    assert_eq!(
        d.files,
        vec![
            FileChange { path: "new.txt".into(), old_path: Some("old.txt".into()), status: FileStatus::Renamed },
            fc("other", FileStatus::Added),
        ]
    );
    // The root commit lists its files too.
    assert_eq!(r.commit_details(&root).unwrap().files, vec![fc("old.txt", FileStatus::Added)]);
}

#[test]
fn diffs_a_file_in_a_commit() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    let a = commit_all(&r, "a");
    write(&r, "f", "2\n");
    let b = commit_all(&r, "b");
    let d = r.diff_commit(&b, "f", None, None, false).unwrap();
    assert!(d.contains("-1\n+2"), "{d}");
    assert!(!d.starts_with("commit "), "no commit header: {d}");
    let root = r.diff_commit(&a, "f", None, None, false).unwrap();
    assert!(root.contains("+1"));
    let vs = r.diff_commit(&b, "f", None, Some(&a), false).unwrap();
    assert_eq!(parse_diff(&vs).hunks, parse_diff(&d).hunks);
}

// ---- conflict-aware ops ----

#[test]
fn reports_merge_conflicts_as_a_state() {
    let r = tmp_repo();
    write(&r, "c.txt", "speed = 100\n");
    commit_all(&r, "base");
    r.create_branch("tune", None, true).unwrap();
    write(&r, "c.txt", "speed = 120\n");
    commit_all(&r, "tune");
    r.checkout("main").unwrap();
    write(&r, "c.txt", "speed = 80\n");
    commit_all(&r, "slow");
    let res = r.merge("tune").unwrap();
    assert!(res.conflict, "{res:?}");
    let info = r.info().unwrap();
    assert_eq!(info.state, Some(RepoState::Merge));
    assert_eq!(info.merge_msg.as_deref().map(|m| m.lines().next().unwrap()), Some("Merge branch 'tune'"));
    assert_eq!(r.status().unwrap().conflicted, vec![fc("c.txt", FileStatus::Conflicted)]);
    assert!(read(&r, "c.txt").contains("<<<<<<<"));
    write(&r, "c.txt", "speed = 90\n");
    r.stage(&["c.txt"]).unwrap();
    assert!(r.status().unwrap().conflicted.is_empty());
    r.commit("Merge tune", "", false).unwrap();
    assert_eq!(sh(&r, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    assert_eq!(r.info().unwrap().state, None);
}

#[test]
fn reports_cherry_pick_and_revert_conflicts() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    commit_all(&r, "base");
    r.create_branch("side", None, true).unwrap();
    write(&r, "f", "side\n");
    let side = commit_all(&r, "side");
    r.checkout("main").unwrap();
    write(&r, "f", "main\n");
    commit_all(&r, "main");
    assert!(r.cherry_pick(&side).unwrap().conflict);
    assert_eq!(r.info().unwrap().state, Some(RepoState::CherryPick));
    sh(&r, &["cherry-pick", "--abort"]);

    write(&r, "g", "1\n");
    let g = commit_all(&r, "add g");
    write(&r, "g", "2\n");
    commit_all(&r, "edit g");
    assert!(r.revert(&g, false).unwrap().conflict);
    assert_eq!(r.info().unwrap().state, Some(RepoState::Revert));
}

#[test]
fn reports_rebase_and_stash_conflicts() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    commit_all(&r, "base");
    r.create_branch("side", None, true).unwrap();
    write(&r, "f", "side\n");
    commit_all(&r, "side");
    r.checkout("main").unwrap();
    write(&r, "f", "main\n");
    commit_all(&r, "main");
    r.checkout("side").unwrap();
    assert!(r.rebase("main").unwrap().conflict);
    assert_eq!(r.info().unwrap().state, Some(RepoState::Rebase));
    sh(&r, &["rebase", "--abort"]);

    write(&r, "f", "stashed\n");
    sh(&r, &["stash"]);
    write(&r, "f", "conflicting\n");
    commit_all(&r, "conflicting");
    assert!(r.stash_apply("stash@{0}").unwrap().conflict);
    sh(&r, &["reset", "-q", "--hard"]);
    assert!(r.stash_pop(None).unwrap().conflict);
}

#[test]
fn fails_clean_merges_of_unknown_refs_with_gits_message() {
    let r = tmp_repo();
    write(&r, "f", "1\n");
    commit_all(&r, "base");
    let err = r.merge("no-such-branch").unwrap_err();
    assert!(err.0.contains("no-such-branch"), "{err}");
    let ok = r.merge("HEAD").unwrap();
    assert!(!ok.conflict);
}

#[test]
fn errors_outside_a_repository() {
    let d = tmp_dir();
    assert!(d.info().is_err());
    assert!(d.status().is_err());
}
