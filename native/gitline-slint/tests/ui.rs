// Headless tests of the Slint window: Slint's testing backend lays the window out at the app's
// minimum size (960x640) and drives it through accessible labels, the way a user would click.
use std::path::Path;

use gitline_core::Repo;
use gitline_slint::{AppWindow, Highlighting, open_repo};
use i_slint_backend_testing::ElementHandle;
use slint::{ComponentHandle, LogicalSize, Model};

fn isolated(path: &Path) -> Repo {
    let cfg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../gitline-core/tests/gitconfig");
    Repo::new(path).with_env("GIT_CONFIG_GLOBAL", cfg).with_env("GIT_CONFIG_NOSYSTEM", "1")
}

fn git(repo: &Repo, args: &[&str]) -> String {
    repo.git(args).unwrap().stdout.trim().to_string()
}

/// A repo with two commits on main, a side branch, a modified file with two hunks and a new file.
fn fixture(dir: &Path) -> Repo {
    let r = isolated(dir);
    r.init().unwrap();
    let body: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    std::fs::write(dir.join("notes.txt"), &body).unwrap();
    std::fs::write(dir.join("main.rs"), "fn main() {}\n").unwrap();
    r.stage_all().unwrap();
    r.commit("First commit", "", false).unwrap();
    git(&r, &["checkout", "-q", "-b", "side"]);
    std::fs::write(dir.join("side.rs"), "// side\n").unwrap();
    r.stage_all().unwrap();
    r.commit("Side work", "", false).unwrap();
    git(&r, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();
    r.stage_all().unwrap();
    r.commit("Say hi", "With a body.", false).unwrap();
    std::fs::write(dir.join("notes.txt"), body.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n")).unwrap();
    std::fs::write(dir.join("new.txt"), "brand new\n").unwrap();
    r
}

fn find(app: &AppWindow, label: &str) -> ElementHandle {
    ElementHandle::find_by_accessible_label(app, label).next().unwrap_or_else(|| panic!("no element labelled {label:?}"))
}

fn click(app: &AppWindow, label: &str) {
    find(app, label).invoke_accessible_default_action();
}

/// The element lies inside the window.
fn assert_on_screen(app: &AppWindow, label: &str) {
    let e = find(app, label);
    let (p, s) = (e.absolute_position(), e.size());
    let w = app.window().size().to_logical(app.window().scale_factor());
    assert!(
        p.x >= 0.0 && p.y >= 0.0 && p.x + s.width <= w.width + 0.5 && p.y + s.height <= w.height + 0.5,
        "{label} at {p:?} {s:?} is off a {w:?} window"
    );
    assert!(s.width > 0.0 && s.height > 0.0, "{label} has no size");
}

#[test]
fn stages_hunks_and_lines_and_commits_at_the_minimum_size() {
    i_slint_backend_testing::init_no_event_loop();
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture(dir.path());
    let (app, c) = open_repo(isolated(dir.path()), Highlighting::Inline).unwrap();
    app.window().set_size(LogicalSize::new(960.0, 640.0));
    app.show().unwrap();

    // The graph lists the WIP row and three commits, with the WIP row selected.
    assert_eq!(app.get_commits().row_count(), 4);
    assert!(app.get_wip_selected());
    assert!(app.get_wip_label().contains("2 unstaged"));
    for label in ["Uncommitted changes", "Say hi", "Side work", "Summary", "Description", "Commit changes", "Stage all"] {
        assert_on_screen(&app, label);
    }
    let main = app.get_commits().row_data(1).unwrap();
    assert_eq!(main.pills.row_data(0).unwrap().label, "main");
    assert!(main.pills.row_data(0).unwrap().head);

    // Open notes.txt and stage its second hunk.
    click(&app, "notes.txt");
    assert!(app.get_diff_open());
    assert!(app.get_diff_can_apply());
    assert_on_screen(&app, "Stage file");
    assert_eq!(app.get_diff_note(), "Plain text");
    click(&app, "Stage hunk 2");
    assert!(git(&repo, &["show", ":notes.txt"]).contains("line twenty-eight"));
    assert_eq!(app.get_staged().row_count(), 1);
    assert!(app.get_diff_open(), "the diff stays open on the rest of the file");

    // Select the "line two" addition (as a drag would) and stage just that line.
    let rows = app.get_diff_rows();
    let add = (0..rows.row_count()).find(|&i| rows.row_data(i).unwrap().text == "line two").unwrap() as i32;
    app.set_sel_anchor(add - 1);
    app.set_sel_cursor(add);
    app.invoke_selection_changed();
    assert_eq!(app.get_sel_changes(), 2);
    app.set_sel_anchor(add);
    app.invoke_selection_changed();
    assert_eq!(app.get_sel_changes(), 1);
    click(&app, "Stage lines");
    let staged = git(&repo, &["show", ":notes.txt"]);
    assert!(staged.contains("line 2\nline two\nline 3"), "{staged}");

    // Copy goes through the clipboard without errors.
    app.set_sel_anchor(1);
    app.set_sel_cursor(2);
    app.invoke_copy_selection();
    assert_eq!(app.get_status_text(), "Copied 2 lines");

    click(&app, "Close");
    assert!(!app.get_diff_open());

    // Stage the new file from its row, then commit.
    click(&app, "Stage new.txt");
    assert_eq!(app.get_staged().row_count(), 2);
    app.set_summary("Update notes".into());
    app.set_description("Two lines.".into());
    click(&app, "Commit changes");
    assert!(!app.get_status_error(), "{}", app.get_status_text());
    assert_eq!(git(&repo, &["log", "-1", "--format=%B"]), "Update notes\n\nTwo lines.");
    assert_eq!(app.get_summary(), "");
    assert_eq!(app.get_staged().row_count(), 0);
    assert_eq!(c.session().status.staged.len(), 0);

    // Select a commit: its details and files replace the staging panel.
    click(&app, "Say hi");
    assert!(!app.get_wip_selected());
    assert_eq!(app.get_commit_title(), "Say hi");
    assert_eq!(app.get_commit_message(), "With a body.");
    assert_eq!(app.get_commit_files().row_count(), 1);
    click(&app, "main.rs");
    assert!(app.get_diff_open());
    assert!(!app.get_diff_can_apply());
    assert_eq!(app.get_diff_note(), "Rust");
    let rows = app.get_diff_rows();
    let add = (0..rows.row_count()).map(|i| rows.row_data(i).unwrap()).find(|r| r.kind == 1).unwrap();
    assert!(add.segs.row_count() > 1, "highlighted into several spans");
    assert!((0..add.segs.row_count()).any(|i| add.segs.row_data(i).unwrap().changed), "word marks");
}

#[test]
fn reports_errors_in_the_status_bar() {
    i_slint_backend_testing::init_no_event_loop();
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture(dir.path());
    let (app, _c) = open_repo(isolated(dir.path()), Highlighting::Inline).unwrap();
    app.window().set_size(LogicalSize::new(960.0, 640.0));
    app.show().unwrap();
    click(&app, "notes.txt");
    // Someone else changes the file underneath, so the open hunk no longer applies.
    std::fs::write(dir.path().join("notes.txt"), "rewritten\n").unwrap();
    git(&repo, &["add", "notes.txt"]);
    click(&app, "Stage hunk 1");
    assert!(app.get_status_error());
    assert!(!app.get_status_text().is_empty());
}

#[test]
fn refuses_a_folder_that_is_not_a_repo() {
    i_slint_backend_testing::init_no_event_loop();
    let dir = tempfile::tempdir().unwrap();
    assert!(open_repo(isolated(dir.path()), Highlighting::Inline).is_err());
}
