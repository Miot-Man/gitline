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

The app opens the repo given on the command line and is laid out like the Electron app's history
view, in its dark theme: the rail of icons, the branches sidebar, the toolbar, the commit graph (or a
diff in its place), the right panel and the status bar. Side-by-side screenshots (Electron on top,
iced below, both taken under Xvfb on the same repo) are in [`docs/screenshots`](docs/screenshots).

**Works for real:**

- **Commit graph:** metro-style lanes, branch and tag pills, the "N uncommitted changes" row, a
  "Commit" header (Author and Date columns appear when the list is wide enough), ↑/↓ to move the
  selection, and commits loaded 5,000 at a time with "Load more commits".
- **Sidebar:** branches (in folders), remotes, stashes and tags, coloured like their lanes, with the
  filter box. Clicking a branch or tag jumps to its commit.
- **Staging panel:** unstaged and staged files with Stage File/Unstage File on hover, Stage all/Unstage
  all, and the Ignored Files list.
- **Commit box:** summary (with the 72-character counter), description, Amend (fills in the last
  message) and the Commit button.
- **Diff view:** hunks as cards with syntax highlighting, word-level highlights, Stage/Unstage per
  hunk, and per line: select text across lines and the hunk's header offers "Stage N lines". Also
  Stage/Unstage File, "Ignore whitespace", plain text versus the detected language, and Esc to go back.
- **Commit details:** the message, author, file counts and files; clicking a file shows its diff, and
  clicking the parent jumps to it.
- **Smooth wheel scrolling** in the graph, diff and sidebar (see below).

**Looks the same but isn't in the spike yet:** fetch, pull and push; undo and redo; branch, stash and
pop; discarding files, hunks or lines; Blame and History; the split diff; the other rail views (pull
requests, search, editor, terminal, folder, settings); repository tabs; co-authors; editing
.gitignore. Clicking one shows a toast saying so. Nothing is discarded or changed by these buttons.

**Known differences from the Electron app:**

- Long diff lines are cut off rather than wrapped in narrow windows. The diff's text is one editor
  with fixed-height lines (so selection works across lines), and wrapping would break that.
- Ligatures (`->` drawn as an arrow) don't show: iced's text engine doesn't turn them on.
- Hunk headers are 38px tall instead of 32px, and a gap between hunks is 19px instead of 14px, because
  they're slots in the editor's fixed line height.
- Tags have a solid outline instead of a dashed one, and the "+" rail tile likewise (iced has no
  dashed borders).
- Only the dark theme.

## Notes on iced

- `text_editor` in read-only mode gives browser-like selection: characters across lines, keyboard
  selection, Ctrl+C. Staging lines follows the text selection.
- The editor can colour text but can't paint line backgrounds. A canvas behind it paints the hunk
  cards, the added/removed rows, the gutters and the word marks. It assumes JetBrains Mono's fixed
  7.2px advance, so very wide characters would misalign the marks.
- The editor redraws every line it holds on every frame. With all 20,000 lines that was about 0.6s
  per frame, so the app froze. It now holds a window of 200 lines around the viewport and moves the
  window while scrolling. A selection survives as long as it stays within the window, and Ctrl+A only
  selects the window.
- Scrolling: iced's scrollable jumps a fixed 60px per mouse-wheel notch. A small wrapper widget
  (`smooth.rs`) catches wheel notches and animates towards the target with an ease-out, with notches
  in quick succession adding up, as in Chromium. Touchpads already send smooth pixel deltas (with the
  OS's momentum), so those pass straight through. The speed (100px per notch) and easing (about
  150ms) are constants to tune by feel.
- There's no virtualized list, so the graph builds only the rows in view, between two spacers sized
  from the scroll offset.
- It has its own look rather than native widgets, but every style closure copies a CSS class from
  `src/styles.css`, and the icons are the same Lucide icons (`assets/icons`, ISC licence).
- `iced_test` simulates the UI headless and clicks widgets by their text.
- iced's `move_to` on a text editor can set a selection but not clear one; clearing it means
  collapsing the selection onto the cursor.
