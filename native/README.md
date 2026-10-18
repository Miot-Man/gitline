# Gitline native spike

A spike that tests whether a native Rust GUI, with no web engine, can handle Gitline's hardest screens:
the commit graph, staging, the diff view and the commit box. The Electron app (`src/`, `electron/`) is
untouched; nothing here is released or packaged.

| Crate | What it is |
|---|---|
| `gitline-core` | The git layer (ported from `electron/git.cjs`), the graph, diff and word-diff logic (from `src/lib/`), syntax highlighting, and `Session`: the screen's state and actions, independent of any toolkit. |
| `gitline-iced` | The screen in [iced](https://iced.rs). |

An earlier version of the spike also built the screen in Slint. It was removed once iced was chosen; it
is still in this branch's history.

## Running

You need Rust (stable) and `git`. On Linux, iced also needs fontconfig and xkbcommon
(`sudo apt install libfontconfig1-dev libxkbcommon-dev libxkbcommon-x11-0`). Build in release mode for a
fair impression of scrolling speed:

```sh
cd native
cargo run --release -p gitline-iced -- /path/to/repo
```

To try them on a large repo (6,000 commits with merged branches and tags, plus `big.rs` rewritten in the
work tree, so its diff has 20,000 changed lines):

```sh
cargo run --release -p gitline-core --example make_big_repo -- /tmp/big-repo
```

`cargo test --workspace` runs everything: the git integration tests (in temporary repos, with git
isolated from your own config by `gitline-core/tests/gitconfig`), the ported unit tests, a scale test,
and headless UI tests of the app at the 960×640 minimum window size.

## What's on screen

The app opens the repo given on the command line and shows:

- **Commit graph:** the history with metro-style lanes, branch and tag labels, and the selected row. An
  "Uncommitted changes" row appears when there are changes.
- **Staging panel:** unstaged and staged files with Stage/Unstage per file (shown on hover), plus
  Stage all/Unstage all.
- **Diff view:** opens in place of the graph, as in the Electron app. It has syntax highlighting,
  word-level highlights, and Stage/Unstage per hunk and per line.
- **Commit box:** summary, description and a Commit button.

Selecting a commit shows its message, author and files; clicking a file shows its diff (read-only).

Screenshots, taken under Xvfb at 960×640, are in [`docs/screenshots`](docs/screenshots).

## Notes on iced

### iced

- `text_editor` in read-only mode gives browser-like selection: characters across lines, keyboard
  selection, Ctrl+C. Staging lines follows the text selection.
- The editor can colour text but can't paint line backgrounds. A canvas behind it paints the
  added/removed rows, the gutters and the word marks. It assumes JetBrains Mono's fixed 7.2px advance,
  so very wide characters would misalign the marks.
- The editor redraws every line it holds on every frame. With all 20,000 lines that was about 0.6s
  per frame, so the app froze. It now holds a window of 200 rows around the viewport and moves the
  window while scrolling. A selection survives as long as it stays within the window, and Ctrl+A only
  selects the window.
- There's no virtualized list, so the graph builds only the rows in view, between two spacers sized
  from the scroll offset.
- It has its own look rather than native widgets, but the flat dark design was easy to match with
  style closures.
- `iced_test` simulates the UI headless and clicks widgets by their text.
