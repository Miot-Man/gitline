# Fixing conflict resolution

A brief for making Gitline's conflict resolution safe and complete. The everyday case works: a text
conflict from a merge or cherry-pick, resolved in the conflict editor. Testing found cases where the app
**loses work** or **gets stuck**. Fix those first (part 1), then improve the editor (part 2).

## Ground rules

- Work on a new branch from `main` (e.g. `conflict-fixes`) and open a PR. Do not touch `main` directly.
- **No releases.** Follow `CLAUDE.md`: no `v*` tags, no `npm version`, no edits to `release.yml`, no GitHub
  releases.
- Before handing back, all three must pass: `npm run typecheck`, `npm test`, `npm run test:e2e`.
- Layouts must work at the minimum window size, 960×640; the end-to-end tests run there.
- Match the existing code: naming, comment density, the flat square UI, existing CSS classes.
- PR #2 (`pr-features`, the pull request panel) is open and also touches `src/components/RepoView.tsx`,
  `src/types.ts`, `e2e/fixtures.ts` and `e2e/app.spec.ts`. Keep changes there focused so the two merge
  cleanly.

## Where the code is

| What | Where |
|---|---|
| Conflict-aware git commands (merge, rebase, cherry-pick, revert, pull, stash apply/pop) | `conflictAware()` and the ops using it in `electron/git.cjs` |
| Which operation is in progress (`info.state`: merge / rebase / cherry-pick / revert) | `ops.info` in `electron/git.cjs` |
| Conflicted files (every unmerged code becomes `status: 'U'`) | `ops.status` in `electron/git.cjs` |
| Take a side for a whole file (`git checkout --ours/--theirs` + `git add`) | `ops.resolve` in `electron/git.cjs` |
| Reading and writing the file being resolved (always as UTF-8) | `ops.readFile` / `ops.writeFile` in `electron/git.cjs` |
| Marker parsing and the result of each choice | `src/lib/conflicts.ts` |
| The conflict editor | `src/components/ConflictEditor.tsx`, opened from `RepoView.tsx` |
| The in-progress banner and the conflicted file list with Ours / Theirs / Resolved | `StagingPanel` in `src/components/RightPanel.tsx` |
| Existing tests | `tests/lib.test.ts` (parser), `tests/git-ops.test.ts` ("merge conflicts"), `e2e/app.spec.ts` ("resolve a merge conflict in the conflict editor") |

## Part 1: correctness

Each problem below was reproduced against `electron/git.cjs` with real git.

### 1. Rebase swaps "ours" and "theirs" (can lose your work)

During a rebase (including pull with rebase and interactive rebase), git's "ours" is the branch being
rebased onto. "Theirs" is **your own commit** being replayed. A real file after a conflicting rebase:

```
<<<<<<< HEAD
upstream
=======
mine
>>>>>>> 119f9c7 (my change)
```

The editor's buttons ("Ours", "All ours") and the file list's Ours / Theirs buttons say "ours" for the
upstream side. Choosing "ours" there throws away the user's own change.

Fix:

- Name the sides by what they are, based on `info.state`. Use these labels everywhere: the conflict cards,
  the "All …" buttons and the file list buttons, with tooltips that say which branch or commit each side
  is.

  | Operation | git "ours" | git "theirs" |
  |---|---|---|
  | merge, pull (merge) | Current branch (`<branch>`) | Incoming (`<merged ref>`) |
  | rebase, pull (rebase) | Upstream (`<onto>`) | Your commit (`<short sha> <subject>`) |
  | cherry-pick | Current branch | Picked commit (`<short sha> <subject>`) |
  | revert | Current branch | Reverted commit's parent version |
  | stash apply / pop | Current files | Stash |

  For rebase, read the commit being applied from `.git/rebase-merge/stopped-sha` (or `REBASE_HEAD`) and
  the target from `.git/rebase-merge/onto`. Add these to what `ops.info` returns.
- Keep the internal values `'ours'` / `'theirs'`; only the wording changes.
- When the user takes the upstream side for a whole file during a rebase, warn first: "This drops your
  commit's changes to `<file>`."

### 2. Files that aren't UTF-8 get corrupted

`readFile` decodes as UTF-8 and `writeFile` writes UTF-8. In a Latin-1 or other 8-bit file, every
non-ASCII byte becomes U+FFFD on read and is written back as `�`, even in lines the user never touched.

Fix: add an op for conflicted files (e.g. `readConflictFile`) that returns the text and the encoding it
used.

- Check whether the bytes are valid UTF-8, e.g. with `new TextDecoder('utf-8', { fatal: true })`.
- If they are, use UTF-8, keeping a BOM if there is one.
- If not, decode as `latin1`, which gives one character per byte, and write back with
  `Buffer.from(text, 'latin1')`. Bytes the user didn't change then come back exactly.
- If the user typed characters that `latin1` can't hold, refuse to save and say why.

Show the encoding in the editor header when it isn't UTF-8.

### 3. Deletion conflicts can't be resolved by deleting

Git gives each conflicted file a two-letter code. The app treats all of them the same (`status: 'U'`):

| Code | Meaning | Ways to resolve |
|---|---|---|
| `UU` | Both modified | Editor |
| `AA` | Both added | Editor |
| `UD` | We modified, they deleted | Keep our file, or delete it |
| `DU` | We deleted, they modified | Keep their file, or delete it |
| `AU` / `UA` | Added on one side only (e.g. a rename clash) | Keep it, or delete it |
| `DD` | Deleted on both sides (e.g. rename/rename) | Delete it |

Reproduced:

- **`UD`:** "Take theirs" (the deleting side) fails with
  `error: path 'a.txt' does not have their version`.
- **`DU`:** "Take ours" fails with `does not have our version`.
- **`DD`:** the file is listed as conflicted, but opening it shows `ENOENT: no such file or directory`.
  Ours and Theirs both fail.

Fix:

- Have `ops.status` return the kind of each conflicted file, e.g. `conflict: 'both-modified' |
  'both-added' | 'deleted-by-us' | 'deleted-by-them' | 'added-by-us' | 'added-by-them' |
  'both-deleted'`. Keep `status: 'U'` so nothing else breaks.
- Show the kind in the conflicted file list ("deleted by them", "both modified", …).
- For the deletion kinds, replace Ours / Theirs with **Keep file** (`git add -- <file>`) and **Delete file**
  (`git rm -q -- <file>`). Only `DD` offers Delete alone.
- Opening a deletion conflict in the editor shows what each side did, plus the file's surviving content
  (read-only), and the same Keep / Delete buttons. It doesn't parse markers there.
- Add an op for deleting (e.g. `resolveDelete`), or extend `ops.resolve` with a `'delete'` choice.

### 4. Stash pop conflicts get no guidance

After `stash pop` conflicts:

- `info.state` is `null`, so there's no banner.
- Git keeps the stash ("The stash entry is kept in case you need it again"), and nothing tells the user.
- "Resolved" stages the file, but a normal stash pop leaves its changes unstaged.

Fix:

- When `stashApply` / `stashPop` returns `conflict: true`, remember it in `RepoView` (which stash, and
  whether it was a pop).
- While conflicted files remain, show a banner like the operation banner: "Applying stash@{0} hit
  conflicts".
- When the last file is resolved, unstage what was staged for the stash (`git reset -q -- <files>`, so
  the changes end up as normal unstaged changes). For a pop, offer **Drop the stash** in a toast.
- If there are conflicted files and no known operation (e.g. the app was restarted), show a generic
  banner: "N files have conflicts". Don't show nothing.

### 5. The base version is never shown

With `merge.conflictStyle = diff3` or `zdiff3`, git writes the original version between `|||||||` and
`=======`. `parseConflicts` already reads it into `base`, but the editor never displays it. Seeing what
both sides started from is often the quickest way to pick correctly.

Fix: show the base in each conflict card when it's present, as a third, collapsible section labelled
"Original". At 960×640 the sides are narrow, so stack the base above them rather than adding a third
column.

## Part 2: editor improvements

Start only once part 1 is done and passing.

- **Context:** show 3 unchanged lines above and below each conflict card, from the text around it.
- **Line numbers:** show line numbers in the cards, matching the result file.
- **Syntax highlighting:** reuse `src/lib/highlight.ts`, which the diff view uses, including the user's
  language rules and the on/off setting.
- **What differs between the sides:** highlight changed words between ours and theirs. Reuse
  `src/lib/wordDiff.ts` and `markRanges` from `highlight.ts`.
- **Navigation:** next / previous conflict buttons and keyboard shortcuts, scrolling the card into view.
- **Result:** keep the editable text box, but scroll it to the matching place when a conflict is chosen.

## Tests

Add tests for each part 1 fix. Model them on the "merge conflicts" tests in `tests/git-ops.test.ts`
(real git in temporary repos) and the conflict test in `e2e/app.spec.ts`.

- **git tests (`tests/git-ops.test.ts`):**
  - `ops.status` reports the right kind for `UU`, `AA`, `UD`, `DU` and `DD`. Rename one file to different
    names on two branches to get `DD` / `AU` / `UA`.
  - Keep file and Delete file resolve `UD`, `DU` and `DD`.
  - `ops.info` during a rebase conflict reports the commit being applied and the target.
  - A Latin-1 file round-trips byte for byte through the conflict read and write ops.
  - After a stash pop conflict, resolving leaves the changes unstaged.
- **Parser tests (`tests/lib.test.ts`):** `zdiff3` output; a file whose content has a line of exactly
  `=======` outside any conflict.
- **End-to-end tests (`e2e/app.spec.ts`), at 960×640:**
  - Rebase conflict: the buttons are labelled "Your commit" / "Upstream", and choosing your commit keeps
    your change after Continue.
  - Modify/delete conflict: Delete file resolves it and Commit merge works.
  - Stash pop conflict: the banner appears; after resolving, the changes are unstaged and dropping the
    stash works.
  - diff3: the "Original" section appears.

## What to hand back

- A PR with part 1 (and part 2 if done), with all checks passing.
- In the PR description:
  - each problem and how it's fixed;
  - screenshots of the conflict editor and the conflicted file list at 960×640, including a rebase
    conflict and a deletion conflict;
  - anything left out and why.
