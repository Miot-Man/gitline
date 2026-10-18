# Full pull request support in the Electron app

A brief for adding complete pull request handling to Gitline's Electron app, so you can review, discuss
and merge PRs without opening github.com.

## Ground rules

- Work on a branch (e.g. `pr-features`) and open a PR. Do not touch `main` directly.
- **No releases.** Follow `CLAUDE.md`: no `v*` tags, no `npm version`, no edits to `release.yml`, no GitHub
  releases.
- Before handing back, all three must pass: `npm run typecheck`, `npm test`, `npm run test:e2e`.
- Layouts must work at the minimum window size, 960×640; the end-to-end tests run there.
- Match the existing code: its naming, comment density, flat square UI, and the way other panels and
  dialogs are built (`src/components/RightPanel.tsx`, `src/components/ui.tsx`, `src/styles.css`).
- This is the Electron app (`src/`, `electron/`). Don't change `native/` (the Rust spike) if it's on the
  branch.

## What exists today

All GitHub access goes through the `gh` CLI. There is no GitHub API client or token handling, and none
should be added: `gh` handles authentication.

- `electron/git.cjs` has the `gh(cwd, args)` helper and these ops: `ghStatus`, `ghPrs` (open PRs with
  head sha, review decision and a checks summary), `ghCiStatus`, `ghCreatePr`, `ghCheckoutPr`,
  `ghMyRepos`, `ghDefaultBranch`.
- `src/types.ts` has `PullRequest` and `GhStatus`.
- `src/components/Sidebar.tsx` lists open PRs. Clicking one runs `selectPr` in
  `src/components/RepoView.tsx`, which fetches the branch if needed and selects the PR's tip in the graph.
  Double-click checks the PR out; right-click offers checkout, show in graph, open on GitHub and copy link.
- `src/components/Rail.tsx` has a PR button with a count badge (`view-prs` command).
- `src/components/CreatePrDialog.tsx` creates PRs.
- The right panel shows `StagingPanel` (working tree), `CommitPanel` (a commit) or `ComparePanel` (two
  commits), chosen in `RepoView.tsx`.
- `ComparePanel` and the `diffRange` op already show the diff between two commits.

## Stage 1: PR panel and actions

### The PR panel

Clicking a PR in the sidebar opens a **PR panel** in the right panel, in place of the commit details.
The graph selection still moves to the PR's tip as it does now. Esc, or selecting a commit, goes back to
the normal panels, the same way `ComparePanel` is closed.

The panel shows:

- **Header:** `#number` and title, state (open / draft / merged / closed), author, `head → base`, and
  created/updated times. Include buttons for Open on GitHub and Copy link.
- **Description:** the PR body, rendered as Markdown. There's no Markdown library yet. Pick a small,
  well-known one (e.g. `marked`) and sanitize its HTML output (e.g. `dompurify`), because PR bodies are
  written by other people. Links open in the browser through the existing `setWindowOpenHandler`.
- **Checks:** each check with its state and a link to its run. Reuse the `summarizeChecks` logic in
  `git.cjs` for the overall state.
- **Reviews:** each reviewer's latest decision (approved / changes requested / commented) and any
  requested reviewers who haven't responded yet.
- **Conversation:** issue comments and review summaries in time order, with author, time and Markdown body.
- **Mergeability:** whether it can be merged, has conflicts, or is blocked (`mergeable`,
  `mergeStateStatus`).

Get this from a single `gh pr view <number> --json …` call through a new `ghPrDetails` op. Use the fields
`number,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,url,createdAt,updatedAt,mergeable,mergeStateStatus,reviewDecision,reviewRequests,reviews,comments,statusCheckRollup,commits,additions,deletions,changedFiles,isCrossRepository`.
Map the result to a typed `PullRequestDetails` in `src/types.ts`, the same way `ghPrs` maps its output.

### Actions

Add each as an op in `git.cjs` and run it through the existing `run(...)` helper in `RepoView.tsx`, so it
gets the busy state, toasts and a refresh. After each action, reload the PR list (`loadPrs`) and the
open PR panel.

| Action | `gh` command | UI |
|---|---|---|
| Merge | `gh pr merge <n> --merge \| --squash \| --rebase` | A split button: the main part uses the last-used method (remember it per repo in settings), and the caret picks another. Disable it with a reason when the PR can't be merged |
| Delete branch after merge | `--delete-branch` on merge | A checkbox beside the merge button |
| Close / reopen | `gh pr close <n>`, `gh pr reopen <n>` | In the panel's menu; close asks for confirmation using the app's existing confirm dialog |
| Mark ready / convert to draft | `gh pr ready <n>`, `gh pr ready <n> --undo` | A button when draft; a menu item when not |
| Comment | `gh pr comment <n> --body-file -` | A text box at the end of the conversation. Pass the body on stdin, not as an argument |
| Review | `gh pr review <n> --approve \| --request-changes \| --comment --body-file -` | A "Review" button with the three choices and an optional message. Hide approve and request changes on your own PRs; GitHub rejects them |
| Edit title / description | `gh pr edit <n> --title … --body-file -` | Edit in place in the header and description |

`git.cjs` has `gitInput` for passing stdin to git. Add the same for `gh` (e.g. `ghInput`) instead of
putting comment bodies on the command line.

### Also

- Add the actions to the PR's right-click menu in the sidebar and to the command palette (`Merge #1…`,
  `Approve #1…`, etc.), the way existing GitHub commands are added in `RepoView.tsx`.
- The rail's PR button with exactly one open PR should open that PR's panel. Today it selects the PR in the
  graph; keep that too.
- Show merged and closed PRs in the panel correctly, since a PR can change state while it's open.
- Any error from `gh` shows as a toast, cleaned up the way `cleanError` does for git.

## Stage 2: changed files and line comments

Only start this once stage 1 is done and passing.

1. **Files changed tab** in the PR panel: the file list and diffs, from the merge base of base and head to
   head. That's the same as `diffRange` with the merge base as `from`. Reuse `ComparePanel` / `DiffView`
   rather than building a new diff view. If the PR's commits aren't fetched, fetch them first (as
   `selectPr` does). For fork PRs, fetch `refs/pull/<n>/head`.
2. **Line comments:** show existing review comments on their lines in the diff view, and let the user add
   one on a line or range. `gh pr` has no command for this, so use `gh api`:
   - read with `repos/{owner}/{repo}/pulls/<n>/comments`;
   - post with a `POST` to the same path, passing `commit_id`, `path`, `line`, `side` and, for a range,
     `start_line`.

   Group replies into threads (`in_reply_to_id`). Comments whose line no longer exists in the current
   diff appear as "outdated", collapsed, under the file.

## Tests

`gh` needs a real GitHub account, which tests can't use, so tests run against a **fake `gh`**:

- Add an override to `findGh()` in `git.cjs`: if the `GITLINE_GH` environment variable is set, use that
  path. It must not change behaviour when the variable is unset.
- Write a small fake `gh` (a Node script, with a `.cmd` wrapper for Windows CI) under `tests/` or `e2e/`.
  It replies to the commands above with canned JSON from a fixture file, and records each call it gets so
  tests can check what was run.
- **Integration tests** (`tests/`, Vitest): each new op calls the right `gh` command with the right
  arguments, maps its output correctly, and passes bodies on stdin.
- **End-to-end tests** (`e2e/`, Playwright):
  - the sidebar lists a PR, and clicking it opens the panel with its description, checks, reviews and
    comments;
  - merging calls `gh pr merge` with the chosen method;
  - commenting and approving send the right commands;
  - the panel fits at 960×640.
- The e2e fixture (`e2e/fixtures.ts`) needs a GitHub-looking remote (e.g. `git remote add origin
  https://github.com/example/repo.git`) so `ghStatus` doesn't stop at "No GitHub remote". It also needs
  the fake `gh` to answer `gh auth status`.

## What to hand back

- A PR with stage 1 (and stage 2 if it got done), the fake `gh`, and the tests, all passing.
- In the PR description:
  - what was built;
  - screenshots of the PR panel at 960×640;
  - anything left out and why;
  - how to try it: run `npm run dev`, open a repo with a GitHub remote and open PRs, and click a PR in
    the sidebar.
