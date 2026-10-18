// Headless tests of the iced screen: iced_test's simulator lays the view out at the app's minimum size
// (960x640) and clicks widgets by their text; the messages it produces go through App::update.
use std::path::Path;

use gitline_core::Repo;
use gitline_core::session::FileList;
use gitline_iced::{App, Highlighting, Message, style};
use iced_test::Simulator;
use iced_test::core::Size;

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

fn ui(app: &App) -> Simulator<'_, Message> {
    Simulator::with_size(style::settings(), Size::new(960.0, 640.0), app.view())
}

/// Clicks the widget showing `label` and feeds the resulting messages to the app.
fn click(app: &mut App, label: &str) {
    let messages: Vec<Message> = {
        let mut ui = ui(app);
        ui.click(label).unwrap_or_else(|e| panic!("clicking {label:?}: {e}"));
        ui.into_messages().collect()
    };
    assert!(!messages.is_empty(), "clicking {label:?} did nothing");
    for m in messages {
        let _ = app.update(m);
    }
}

/// The text is laid out inside the 960x640 window.
fn assert_on_screen(app: &App, label: &str) {
    let mut ui = ui(app);
    let target = ui.find(label).unwrap_or_else(|e| panic!("{label:?}: {e}"));
    let b = iced_test::selector::Bounded::visible_bounds(&target).unwrap_or_else(|| panic!("{label:?} is not visible"));
    assert!(b.x >= 0.0 && b.y >= 0.0 && b.x + b.width <= 960.5 && b.y + b.height <= 640.5, "{label:?} at {b:?} is off screen");
}

#[test]
fn stages_hunks_and_lines_and_commits_at_the_minimum_size() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture(dir.path());
    let mut app = App::open(isolated(dir.path()), Highlighting::Inline).unwrap();

    assert!(app.session.wip_selected());
    for label in ["Uncommitted changes · 2 unstaged", "Say hi", "Side work", "main", "Stage all", "Stage files to commit", "notes.txt"] {
        assert_on_screen(&app, label);
    }

    // Open notes.txt and stage its second hunk.
    click(&mut app, "notes.txt");
    assert!(app.session.diff.as_ref().is_some_and(|d| d.can_apply() && d.highlighted));
    assert_on_screen(&app, "Stage file");
    assert_on_screen(&app, "Plain text");
    let rows = app.session.diff.as_ref().unwrap().view.rows.clone();
    let second_hunk = rows.iter().rposition(|r| r.line.is_none()).unwrap();
    let _ = app.update(Message::ApplyHunk(rows[second_hunk].hunk));
    assert!(git(&repo, &["show", ":notes.txt"]).contains("line twenty-eight"));
    assert_eq!(app.session.status.staged.len(), 1);
    assert!(app.session.diff.is_some(), "the diff stays open on the rest of the file");

    // Select from the end of "line 2" into "line two" in the text, then stage the lines it touches.
    let rows = app.session.diff.as_ref().unwrap().view.rows.clone();
    let add = rows.iter().position(|r| r.text == "line two").unwrap();
    app.select_diff_rows(add - 1, add);
    assert_on_screen(&app, "Stage 2 lines");
    assert_on_screen(&app, "Copy");
    app.select_diff_rows(add, add);
    click(&mut app, "Stage 1 line");
    let staged = git(&repo, &["show", ":notes.txt"]);
    assert!(staged.contains("line 2\nline two\nline 3"), "{staged}");

    click(&mut app, "Close");
    assert!(app.session.diff.is_none());

    // Stage the new file, then commit through the commit box.
    let i = app.session.files(FileList::Unstaged).iter().position(|f| f.path == "new.txt").unwrap();
    let _ = app.update(Message::StageFile(i));
    let _ = app.update(Message::Summary("Update notes".into()));
    click(&mut app, "Commit 2 files");
    assert!(!app.status_error, "{}", app.status);
    assert_eq!(git(&repo, &["log", "-1", "--format=%B"]), "Update notes");
    assert!(app.summary.is_empty());

    // Select a commit: its details and files replace the staging panel.
    click(&mut app, "Say hi");
    assert!(!app.session.wip_selected());
    assert_on_screen(&app, "With a body.");
    click(&mut app, "main.rs");
    let d = app.session.diff.as_ref().unwrap();
    assert!(!d.can_apply());
    assert_on_screen(&app, "Rust");
}

#[test]
fn copies_the_selected_text() {
    let dir = tempfile::tempdir().unwrap();
    fixture(dir.path());
    let mut app = App::open(isolated(dir.path()), Highlighting::Inline).unwrap();
    click(&mut app, "notes.txt");
    let rows = app.session.diff.as_ref().unwrap().view.rows.clone();
    let add = rows.iter().position(|r| r.text == "line two").unwrap();
    app.select_diff_rows(add - 1, add);
    assert_eq!(app.diff_content.selection().as_deref(), Some("line 2\nline two"));
    let _ = app.update(Message::Copy);
    assert_eq!(app.status, "Copied 2 lines");
}

#[test]
fn reports_errors_in_the_status_bar() {
    let dir = tempfile::tempdir().unwrap();
    let repo = fixture(dir.path());
    let mut app = App::open(isolated(dir.path()), Highlighting::Inline).unwrap();
    click(&mut app, "notes.txt");
    std::fs::write(dir.path().join("notes.txt"), "rewritten\n").unwrap();
    git(&repo, &["add", "notes.txt"]);
    let _ = app.update(Message::ApplyHunk(0));
    assert!(app.status_error);
    assert_on_screen(&app, &app.status.clone());
}

#[test]
fn refuses_a_folder_that_is_not_a_repo() {
    let dir = tempfile::tempdir().unwrap();
    assert!(App::open(isolated(dir.path()), Highlighting::Inline).is_err());
}
