# Gitline

A desktop Git client for macOS, Windows and Linux, built with Electron, React and TypeScript. It shells out to your installed `git` (and `gh` for GitHub features), so your existing config, credentials and SSH keys just work.

## Install

Download the installer for your OS from the [Releases](https://github.com/Miot-Man/gitline/releases) page:

- **macOS:** `.dmg`. The app isn't code-signed yet, so the first time, right-click Gitline → Open.
- **Windows:** `.exe` installer. SmartScreen may warn because it's unsigned: More info → Run anyway.
- **Fedora:** `sudo dnf install ./Gitline-*.rpm`
- **Arch:** `sudo pacman -U Gitline-*.pacman`
- **Any Linux:** the `.AppImage`: make it executable (`chmod +x`) and run it.

Requires `git`. GitHub pull requests need the [GitHub CLI](https://cli.github.com) signed in with `gh auth login`.

## Develop

```sh
npm install
npm run dev        # hot-reloading dev mode
npm start          # production build + launch
npm test           # unit + git integration tests (Vitest)
npm run test:e2e   # end-to-end tests that drive the app (Playwright)
npm run dist       # build installers for this OS into release/
```

## Releasing

Push a version tag and GitHub Actions builds installers for all three OSes and attaches them to a draft GitHub Release:

```sh
npm version patch   # bumps package.json and tags, e.g. v0.1.1
git push --follow-tags
```

Then publish the draft on GitHub. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests and end-to-end tests on macOS, Windows and Linux for every push to `main` and every pull request.

## Layout

- `electron/git.cjs`: every git operation (log, status, diff, stage, commit, merge, rebase, worktrees, GitHub via `gh`, …)
- `electron/main.cjs`: window, menus, IPC, file watching, recent repos, external editor
- `electron/preload.cjs`: the `window.api` bridge
- `src/lib/`: graph layout, diff/patch building, undo history, conflict parsing, settings
- `src/components/`: UI (`RepoView` orchestrates the toolbar, sidebar, graph, diff and right panel)
- `tests/`: Vitest unit and git integration tests; `e2e/`: Playwright tests
