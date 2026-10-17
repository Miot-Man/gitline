// Thin wrapper around the git CLI. Every op takes the repo path as its first argument.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEP = '\x1f';
const REC = '\x1e';

// Read at call time so changes to the environment (e.g. which global config to use) take effect.
const ENV = () => ({
  ...process.env,
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_OPTIONAL_LOCKS: '0',
});

function git(cwd, args, { allowFail = false, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, env: { ...ENV(), ...env }, maxBuffer: 512 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          reject(new Error((stderr || stdout || err.message).trim()));
          return;
        }
        resolve({ stdout, stderr, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
      }
    );
  });
}

function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: ENV() });
    let out = '';
    let errOut = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((errOut || out).trim()))));
    p.stdin.end(input);
  });
}

// Like git(), but returns stdout as a Buffer (for binary blobs).
function gitBuffer(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: ENV(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.toString().trim() || err.message)) : resolve(stdout)
    );
  });
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };

// Apps launched from Finder get a minimal PATH, so look for gh where package managers put it.
const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'];
let ghPath;
function findGh() {
  if (ghPath !== undefined) return ghPath;
  ghPath = GH_CANDIDATES.find((p) => fs.existsSync(p)) ?? 'gh';
  return ghPath;
}

function gh(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      findGh(),
      args,
      { cwd, env: { ...ENV(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = err.code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com.' : (stderr || stdout || err.message).trim();
          reject(new Error(msg));
        } else resolve(stdout);
      }
    );
  });
}

// Where a bisect stands after a step, worked out from bisect's own refs rather than its messages
// (the wording, and whether the result is logged, differ between git versions). The candidates are the
// commits reachable from the bad commit but from no good one; once only the bad commit is left, it's
// the first bad commit.
async function bisectResult(cwd) {
  const bad = (await git(cwd, ['rev-parse', '--verify', '-q', 'refs/bisect/bad'], { allowFail: true })).stdout.trim();
  if (!bad) return { done: false, left: null, steps: null };
  const refs = async (pattern) => lines((await git(cwd, ['for-each-ref', '--format=%(objectname)', pattern])).stdout);
  const goods = await refs('refs/bisect/good-*');
  const skips = new Set(await refs('refs/bisect/skip-*'));
  const candidates = lines((await git(cwd, ['rev-list', bad, ...(goods.length ? ['--not', ...goods] : [])])).stdout);
  if (candidates.length <= 1) return { done: true, firstBad: bad };
  const untested = candidates.filter((c) => c !== bad && !skips.has(c));
  if (!untested.length) {
    return { done: true, firstBad: null, message: `Couldn't narrow it down: the first bad commit is one of ${candidates.length} commits, and the rest were skipped.` };
  }
  return { done: false, left: untested.length - 1, steps: Math.ceil(Math.log2(untested.length + 1)) - 1 };
}

const IDENTITY_DIR = () => path.join(os.homedir(), '.config', 'gitline', 'identities');
const expandHome = (p) => p.replace(/^~(?=[\\/]|$)/, os.homedir());
const isManagedIdentity = (file) => path.resolve(expandHome(file)).startsWith(path.resolve(IDENTITY_DIR()));

// Resolves a repo-relative path, refusing anything that escapes the repo.
function repoFile(cwd, file) {
  const full = path.resolve(cwd, file);
  const rel = path.relative(cwd, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path is outside the repository: ${file}`);
  return full;
}

// Runs an op that may stop on conflicts (merge, rebase, cherry-pick, ...).
async function conflictAware(cwd, args, env) {
  const r = await git(cwd, args, { allowFail: true, env });
  const text = r.stdout + r.stderr;
  if (r.code === 0) return { conflict: false, output: text.trim() };
  if (/CONFLICT|could not apply|after resolving the conflicts/i.test(text)) return { conflict: true, output: text.trim() };
  throw new Error(text.trim());
}

const exists = (...p) => fs.existsSync(path.join(...p));
// Quotes a path for git's sh (Git for Windows ships one too, which prefers forward slashes).
const shellQuote = (s) => `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
const lines = (s) => s.split('\n').filter(Boolean);

async function hasHead(cwd) {
  return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).code === 0;
}

function parseNameStatus(out) {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length && t[i]; ) {
    const status = t[i];
    if (status[0] === 'R' || status[0] === 'C') {
      files.push({ status: status[0], oldPath: t[i + 1], path: t[i + 2] });
      i += 3;
    } else {
      files.push({ status: status[0], path: t[i + 1] });
      i += 2;
    }
  }
  return files;
}

// Collapses a PR's check runs / commit statuses into one state.
function summarizeChecks(rollup) {
  if (!rollup.length) return null;
  const states = rollup.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'failure';
  if (states.some((s) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED', ''].includes(s))) return 'pending';
  return 'success';
}

const ops = {
  async toplevel(cwd) {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  },

  async info(cwd) {
    const [head, branch, gitDir, remotes] = await Promise.all([
      git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }),
      git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }),
      git(cwd, ['rev-parse', '--absolute-git-dir']),
      git(cwd, ['remote']),
    ]);
    const gd = gitDir.stdout.trim();
    let state = null;
    const bisecting = exists(gd, 'BISECT_LOG');
    if (exists(gd, 'rebase-merge') || exists(gd, 'rebase-apply')) state = 'rebase';
    else if (exists(gd, 'MERGE_HEAD')) state = 'merge';
    else if (exists(gd, 'CHERRY_PICK_HEAD')) state = 'cherry-pick';
    else if (exists(gd, 'REVERT_HEAD')) state = 'revert';
    let mergeMsg = null;
    if (state && state !== 'rebase') {
      try {
        mergeMsg = fs
          .readFileSync(path.join(gd, 'MERGE_MSG'), 'utf8')
          .split('\n')
          .filter((l) => !l.startsWith('#'))
          .join('\n')
          .trim();
      } catch {}
    }
    // FETCH_HEAD is rewritten on every fetch/pull, so its mtime is when the repo last talked to a remote.
    let fetchedAt = null;
    try {
      fetchedAt = fs.statSync(path.join(gd, 'FETCH_HEAD')).mtimeMs;
    } catch {}
    return {
      head: head.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
      state,
      mergeMsg,
      remotes: lines(remotes.stdout),
      fetchedAt,
      bisecting,
    };
  },

  // `filter.solo` limits the graph to those refs (plus HEAD); `filter.hidden` drops refs from --all.
  async log(cwd, limit = 5000, filter = {}) {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';
    const { solo = [], hidden = [] } = filter;
    const revs = solo.length ? ['--ignore-missing', ...solo, 'HEAD'] : [...hidden.map((h) => `--exclude=${h}`), '--exclude=refs/stash', '--all'];
    const r = await git(cwd, ['log', ...revs, '--date-order', '-n', String(limit), `--pretty=format:${fmt}`, '--'], { allowFail: true });
    if (r.code !== 0) return [];
    return r.stdout
      .split(REC)
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((s) => {
        const [sha, p, author, email, t, subject] = s.split(SEP);
        return { sha, parents: p ? p.split(' ') : [], author, email, time: Number(t), subject };
      });
  },

  async refs(cwd) {
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)'].join('%1f');
    const r = await git(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    return lines(r.stdout)
      .map((l) => {
        const [full, obj, peeled, upstream, track, head] = l.split(SEP);
        let type, name, remote;
        if (full.startsWith('refs/heads/')) {
          type = 'local';
          name = full.slice(11);
        } else if (full.startsWith('refs/remotes/')) {
          type = 'remote';
          name = full.slice(13);
          remote = name.split('/')[0];
        } else {
          type = 'tag';
          name = full.slice(10);
        }
        return { full, name, type, remote, sha: peeled || obj, upstream: upstream || undefined, track: track || undefined, isHead: head === '*' };
      })
      .filter((r) => !(r.type === 'remote' && (r.name.endsWith('/HEAD') || !r.name.includes('/'))));
  },

  async stashes(cwd) {
    const r = await git(cwd, ['stash', 'list', '--format=%gd%x1f%H%x1f%s'], { allowFail: true });
    return lines(r.stdout).map((l) => {
      const [ref, sha, message] = l.split(SEP);
      return { ref, sha, message, index: Number((ref.match(/\{(\d+)\}/) || [])[1] || 0) };
    });
  },

  async status(cwd) {
    const r = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
    const parts = r.stdout.split('\0');
    const staged = [];
    const unstaged = [];
    const conflicted = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (!e) continue;
      const x = e[0];
      const y = e[1];
      const p = e.slice(3);
      let oldPath;
      if (x === 'R' || x === 'C') oldPath = parts[++i];
      const xy = x + y;
      if (xy === '!!') continue;
      if (xy === '??') {
        unstaged.push({ path: p, status: '?' });
        continue;
      }
      if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) {
        conflicted.push({ path: p, status: 'U' });
        continue;
      }
      if (x !== ' ') staged.push({ path: p, oldPath, status: x });
      if (y !== ' ') unstaged.push({ path: p, status: y });
    }
    return { staged, unstaged, conflicted };
  },

  // `ignoreWs` hides whitespace-only changes (git diff -w); such diffs can't be applied back as patches.
  async diffWorking(cwd, file, staged, untracked, oldPath, ignoreWs) {
    if (untracked) {
      return (await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file], { allowFail: true })).stdout;
    }
    const args = ['diff', '--no-ext-diff', '-M', ...(ignoreWs ? ['-w'] : [])];
    if (staged) args.push('--cached');
    args.push('--', ...(oldPath ? [oldPath, file] : [file]));
    return (await git(cwd, args)).stdout;
  },

  async diffCommit(cwd, sha, file, oldPath, parent, ignoreWs) {
    const paths = oldPath ? [oldPath, file] : [file];
    const ws = ignoreWs ? ['-w'] : [];
    if (parent) return (await git(cwd, ['diff', '--no-ext-diff', '-M', ...ws, parent, sha, '--', ...paths])).stdout;
    return (await git(cwd, ['show', '--no-ext-diff', '--format=', '-M', ...ws, sha, '--', ...paths])).stdout;
  },

  async commitDetails(cwd, sha) {
    const r = await git(cwd, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', sha]);
    const [h, p, an, ae, at, cn, ce, ct, body] = r.stdout.split(SEP);
    const parents = p ? p.split(' ') : [];
    const f = await git(
      cwd,
      parents.length
        ? ['diff', '--name-status', '-z', '-M', parents[0], sha]
        : ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '-z', '-M', sha]
    );
    return {
      sha: h,
      parents,
      author: an,
      email: ae,
      time: Number(at),
      committer: cn,
      committerEmail: ce,
      commitTime: Number(ct),
      message: (body || '').trimEnd(),
      files: parseNameStatus(f.stdout),
    };
  },

  // Server-side commit search: 'changes' greps diffs (-G), 'path' matches touched file paths.
  async searchCommits(cwd, mode, query, limit = 2000) {
    const base = ['log', '--all', '--exclude=refs/stash', '--format=%H', '-n', String(limit)];
    let args;
    if (mode === 'changes') args = [...base, '-i', `-G${query}`];
    else {
      const q = query.replace(/[*?[\]\\]/g, '\\$&');
      args = [...base, '--', `:(glob,icase)**/*${q}*`, `:(glob,icase)**/*${q}*/**`];
    }
    const r = await git(cwd, args, { allowFail: true });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Search failed');
    return lines(r.stdout);
  },

  // Files changed between two commits.
  async diffRange(cwd, from, to) {
    return parseNameStatus((await git(cwd, ['diff', '--name-status', '-z', '-M', from, to])).stdout);
  },

  // History of one file, following renames. Each entry carries the file's path at that commit.
  async fileLog(cwd, file, limit = 1000) {
    const fmt = '%x1e' + ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');
    const r = await git(cwd, ['log', '--follow', '-M', '-n', String(limit), `--format=${fmt}`, '--name-status', '-z', '--', file], { allowFail: true });
    if (r.code !== 0) return [];
    return r.stdout
      .split(REC)
      .filter(Boolean)
      .map((rec) => {
        // With -z the header is NUL-terminated and followed by the NUL-separated name-status fields.
        const end = rec.indexOf('\0');
        const [sha, p, author, email, t, subject] = rec.slice(0, end < 0 ? undefined : end).split(SEP);
        const files = end < 0 ? [] : parseNameStatus(rec.slice(end + 1).replace(/^[\n\0]+/, ''));
        const f = files[0] ?? { status: 'M', path: file };
        return { sha, parents: p ? p.split(' ') : [], author, email, time: Number(t), subject, file: f };
      });
  },

  // Blame of a file at `rev`, or the working copy when rev is omitted.
  async blame(cwd, file, rev) {
    const r = await git(cwd, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', file]);
    const commits = {};
    const out = [];
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('\t')) {
        out.push({ sha: cur, text: line.slice(1) });
        continue;
      }
      const m = line.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (m) {
        cur = m[1];
        commits[cur] ??= { author: '', email: '', time: 0, summary: '' };
        continue;
      }
      const sp = line.indexOf(' ');
      const key = line.slice(0, sp);
      const val = line.slice(sp + 1);
      const c = cur && commits[cur];
      if (!c) continue;
      if (key === 'author') c.author = val;
      else if (key === 'author-mail') c.email = val.replace(/^<|>$/g, '');
      else if (key === 'author-time') c.time = Number(val);
      else if (key === 'summary') c.summary = val;
    }
    return { commits, lines: out };
  },

  async lastCommitMessage(cwd) {
    return (await git(cwd, ['log', '-1', '--format=%B'])).stdout.trimEnd();
  },

  // ---- working tree ----
  async stage(cwd, paths) {
    await git(cwd, ['add', '-A', '--', ...paths]);
  },
  async stageAll(cwd) {
    await git(cwd, ['add', '-A']);
  },
  async unstage(cwd, paths) {
    if (await hasHead(cwd)) await git(cwd, ['reset', '-q', 'HEAD', '--', ...paths]);
    else await git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths]);
  },
  async unstageAll(cwd) {
    if (await hasHead(cwd)) await git(cwd, ['reset', '-q']);
    else await git(cwd, ['rm', '--cached', '-r', '-q', '.']);
  },
  async discard(cwd, files) {
    const untracked = files.filter((f) => f.status === '?').map((f) => f.path);
    const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
    if (untracked.length) await git(cwd, ['clean', '-f', '-q', '--', ...untracked]);
    if (tracked.length) await git(cwd, ['checkout', '-q', '--', ...tracked]);
  },
  async discardAll(cwd) {
    if (await hasHead(cwd)) await git(cwd, ['reset', '--hard', '-q']);
    await git(cwd, ['clean', '-fd', '-q']);
  },
  async applyPatch(cwd, patch, cached, reverse) {
    // --recount: line-level patches are built in the UI without exact hunk header counts.
    const args = ['apply', '--whitespace=nowarn', '--recount'];
    if (cached) args.push('--cached');
    if (reverse) args.push('--reverse');
    args.push('-');
    await gitInput(cwd, args, patch);
  },
  async ignore(cwd, pattern) {
    const file = path.join(cwd, '.gitignore');
    let cur = '';
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch {}
    fs.writeFileSync(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n');
  },
  async commit(cwd, summary, description, amend) {
    const args = ['commit', '-q', '-m', summary];
    if (description && description.trim()) args.push('-m', description.trim());
    if (amend) args.push('--amend');
    await git(cwd, args);
  },

  // ---- branches / refs ----
  async checkout(cwd, ref) {
    await git(cwd, ['checkout', '-q', ref]);
  },
  async checkoutRemote(cwd, remoteBranch) {
    const local = remoteBranch.split('/').slice(1).join('/');
    const r = await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { allowFail: true });
    if (r.code === 0) await git(cwd, ['checkout', '-q', local]);
    else await git(cwd, ['checkout', '-q', '--track', remoteBranch]);
  },
  async createBranch(cwd, name, start, checkout) {
    const s = start ? [start] : [];
    if (checkout) await git(cwd, ['checkout', '-q', '-b', name, ...s]);
    else await git(cwd, ['branch', name, ...s]);
  },
  async deleteBranch(cwd, name, force) {
    await git(cwd, ['branch', force ? '-D' : '-d', name]);
  },
  async deleteRemoteBranch(cwd, remote, branch) {
    await git(cwd, ['push', remote, '--delete', branch]);
  },
  async renameBranch(cwd, oldName, newName) {
    await git(cwd, ['branch', '-m', oldName, newName]);
  },
  merge: (cwd, ref) => conflictAware(cwd, ['merge', '--no-edit', ref]),
  rebase: (cwd, onto) => conflictAware(cwd, ['rebase', onto]),
  cherryPick: (cwd, sha) => conflictAware(cwd, ['cherry-pick', sha]),
  revert: (cwd, sha, isMerge) => conflictAware(cwd, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), sha]),
  // Commits an interactive rebase onto `base` would replay, oldest first.
  async rebasePlan(cwd, base) {
    const anc = await git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD'], { allowFail: true });
    if (anc.code !== 0) throw new Error('That commit is not an ancestor of the current branch.');
    const r = await git(cwd, ['log', '--reverse', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e', `${base}..HEAD`]);
    const commits = r.stdout
      .split(REC)
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((s) => {
        const [sha, p, author, email, t, message] = s.split(SEP);
        return { sha, parents: p ? p.split(' ') : [], author, email, time: Number(t), message: message.trimEnd() };
      });
    if (commits.some((c) => c.parents.length > 1)) throw new Error('Interactive rebase over merge commits is not supported.');
    return commits;
  },

  // Runs `git rebase -i` non-interactively. `steps` is newest-last: { sha, action, message? }.
  // Rewords are done with `exec git commit --amend -F <file>` so no editor is needed.
  async interactiveRebase(cwd, base, steps) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitline-rebase-'));
    const todo = [];
    steps.forEach((s, i) => {
      if (s.action === 'reword') {
        const msgFile = path.join(dir, `msg-${i}`);
        fs.writeFileSync(msgFile, s.message);
        todo.push(`pick ${s.sha}`, `exec git commit --amend -q --allow-empty -F ${shellQuote(msgFile)}`);
      } else todo.push(`${s.action} ${s.sha}`);
    });
    const todoFile = path.join(dir, 'todo');
    fs.writeFileSync(todoFile, todo.join('\n') + '\n');
    try {
      return await conflictAware(cwd, ['rebase', '-i', '--autostash', base], { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoFile)}` });
    } finally {
      // Message files are read by `exec` lines that may run later (after a conflict), so keep those.
      fs.rmSync(todoFile, { force: true });
    }
  },

  async reset(cwd, sha, mode) {
    await git(cwd, ['reset', '-q', `--${mode}`, sha]);
  },
  async abort(cwd, state) {
    const cmd = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[state];
    await git(cwd, [cmd, '--abort']);
  },
  async continueOp(cwd, state) {
    if (state === 'merge') return conflictAware(cwd, ['commit', '--no-edit']);
    return conflictAware(cwd, [state, '--continue']);
  },
  async skipRebase(cwd) {
    return conflictAware(cwd, ['rebase', '--skip']);
  },
  async resolve(cwd, file, side) {
    await git(cwd, ['checkout', `--${side}`, '--', file]);
    await git(cwd, ['add', '--', file]);
  },

  // ---- undo / redo primitives ----
  async headState(cwd) {
    const [head, branch] = await Promise.all([
      git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }),
      git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }),
    ]);
    return { head: head.stdout.trim() || null, branch: branch.stdout.trim() || null };
  },
  // Unpeeled, so an annotated tag resolves to its tag object rather than the commit.
  async refSha(cwd, full) {
    const r = await git(cwd, ['rev-parse', '--verify', '-q', full], { allowFail: true });
    return r.stdout.trim() || null;
  },
  // Creates a ref that must not already exist.
  async createRef(cwd, full, sha) {
    await git(cwd, ['update-ref', full, sha, '']);
  },
  // Deletes a ref only if it still points where we expect.
  async deleteRef(cwd, full, sha) {
    await git(cwd, ['update-ref', '-d', full, sha]);
  },

  // ---- bisect: find the commit that introduced a problem ----
  async bisectStart(cwd, bad, good) {
    await git(cwd, ['bisect', 'start']);
    await git(cwd, ['bisect', 'bad', bad]);
    await git(cwd, ['bisect', 'good', good]);
    return bisectResult(cwd);
  },
  // `verdict` is good, bad or skip; `sha` defaults to the commit being tested.
  async bisectMark(cwd, verdict, sha) {
    await git(cwd, ['bisect', verdict, ...(sha ? [sha] : [])]);
    return bisectResult(cwd);
  },
  async bisectReset(cwd) {
    await git(cwd, ['bisect', 'reset']);
  },

  // ---- recovering lost work ----
  // Recent HEAD reflog entries, each flagged when its commit is no longer reachable from any branch or tag.
  async reflog(cwd, limit = 200) {
    const r = await git(cwd, ['reflog', '-n', String(limit), '--format=%H%x1f%gd%x1f%gs%x1f%ct%x1f%s'], { allowFail: true });
    if (r.code !== 0) return [];
    const entries = lines(r.stdout).map((l) => {
      const [sha, ref, action, time, subject] = l.split(SEP);
      return { sha, ref, action, time: Number(time), subject };
    });
    const shas = [...new Set(entries.map((e) => e.sha))];
    // For each commit, check whether any branch/tag/remote still contains it.
    const reachable = new Set();
    for (const sha of shas) {
      const c = await git(cwd, ['for-each-ref', '--count=1', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'], { allowFail: true });
      if (c.stdout.trim()) reachable.add(sha);
    }
    return entries.map((e) => ({ ...e, lost: !reachable.has(e.sha) }));
  },

  // ---- worktrees ----
  async worktrees(cwd) {
    const [r, top] = await Promise.all([git(cwd, ['worktree', 'list', '--porcelain']), git(cwd, ['rev-parse', '--show-toplevel'])]);
    const here = path.resolve(top.stdout.trim());
    return r.stdout
      .split(/\n\n+/)
      .filter((b) => b.startsWith('worktree '))
      .map((block) => {
        const wt = { path: '', head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, current: false };
        for (const line of block.split('\n')) {
          const [key, ...rest] = line.split(' ');
          const val = rest.join(' ');
          if (key === 'worktree') wt.path = val;
          else if (key === 'HEAD') wt.head = val;
          else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '');
          else if (key === 'detached') wt.detached = true;
          else if (key === 'bare') wt.bare = true;
          else if (key === 'locked') wt.locked = true;
          else if (key === 'prunable') wt.prunable = true;
        }
        wt.current = path.resolve(wt.path) === here;
        return wt;
      });
  },
  // Checks out `branch` in a new folder. With `newBranch`, creates that branch from `branch` first.
  async addWorktree(cwd, dir, branch, newBranch) {
    await git(cwd, ['worktree', 'add', ...(newBranch ? ['-b', newBranch, dir, branch] : [dir, branch])]);
    return dir;
  },
  async removeWorktree(cwd, dir, force) {
    await git(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  },
  async pruneWorktrees(cwd) {
    await git(cwd, ['worktree', 'prune']);
  },

  // ---- submodules ----
  async submodules(cwd) {
    if (!exists(cwd, '.gitmodules')) return [];
    const r = await git(cwd, ['submodule', 'status', '--recursive'], { allowFail: true });
    const states = { ' ': 'ok', '-': 'uninitialized', '+': 'modified', U: 'conflict' };
    return lines(r.stdout).map((l) => {
      const m = l.match(/^(.)([0-9a-f]+) (\S+)(?: \((.*)\))?$/) ?? [];
      return { state: states[m[1]] ?? 'ok', sha: m[2] ?? '', path: m[3] ?? l.trim(), describe: m[4] ?? null };
    });
  },
  async updateSubmodules(cwd, sub) {
    await git(cwd, ['submodule', 'update', '--init', '--recursive', ...(sub ? ['--', sub] : [])]);
  },

  // ---- Git LFS ----
  async lfsInfo(cwd) {
    let attrs = '';
    try {
      attrs = fs.readFileSync(path.join(cwd, '.gitattributes'), 'utf8');
    } catch {}
    if (!/filter=lfs/.test(attrs)) return { used: false, installed: false, files: 0 };
    const v = await git(cwd, ['lfs', 'version'], { allowFail: true });
    if (v.code !== 0) return { used: true, installed: false, files: 0 };
    const files = await git(cwd, ['lfs', 'ls-files', '--name-only'], { allowFail: true });
    return { used: true, installed: true, files: lines(files.stdout).length };
  },
  async lfsPull(cwd) {
    await git(cwd, ['lfs', 'pull']);
  },

  // ---- ignored files ----
  async ignoredFiles(cwd) {
    // Traditional mode lists an ignored directory once instead of every file inside it.
    const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--ignored=traditional', '-unormal']);
    return r.stdout
      .split('\0')
      .filter((e) => e.startsWith('!! '))
      .map((e) => e.slice(3));
  },

  // An image as a data: URL. `rev` is a commit, ':' for the index, or null for the working copy.
  // Returns null when the file doesn't exist on that side.
  async imageData(cwd, rev, file) {
    const type = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (!type) return null;
    let buf;
    try {
      if (rev === null) buf = fs.readFileSync(repoFile(cwd, file));
      else buf = await gitBuffer(cwd, ['show', rev === ':' ? `:${file}` : `${rev}:${file}`]);
    } catch {
      return null;
    }
    return { url: `data:${type};base64,${buf.toString('base64')}`, size: buf.length };
  },

  // ---- conflict editing ----
  async readFile(cwd, file) {
    return fs.readFileSync(repoFile(cwd, file), 'utf8');
  },
  async writeFile(cwd, file, content) {
    fs.writeFileSync(repoFile(cwd, file), content);
  },

  // ---- config / identity ----
  // Global config is read from the home directory so it works without a repository.
  async getConfig(cwd, key, scope) {
    if (scope === 'global') cwd = os.homedir();
    const r = await git(cwd, ['config', ...(scope ? [`--${scope}`] : []), '--get', key], { allowFail: true });
    return r.stdout.trim() || null;
  },
  async setConfig(cwd, key, value, scope) {
    if (scope === 'global') cwd = os.homedir();
    const s = scope ? [`--${scope}`] : [];
    if (value === null || value === '') await git(cwd, ['config', ...s, '--unset', key], { allowFail: true });
    else await git(cwd, ['config', ...s, key, value]);
  },
  // The file named by commit.template, if one is configured.
  async commitTemplate(cwd) {
    const r = await git(cwd, ['config', '--path', '--get', 'commit.template'], { allowFail: true });
    const file = r.stdout.trim();
    if (!file) return null;
    try {
      return fs.readFileSync(path.resolve(cwd, file.replace(/^~(?=\/)/, os.homedir())), 'utf8');
    } catch {
      return null;
    }
  },
  // Distinct authors seen in recent history, most frequent first.
  async authors(cwd) {
    const r = await git(cwd, ['log', '--all', '-n', '3000', '--format=%an%x1f%ae'], { allowFail: true });
    const counts = new Map();
    for (const l of lines(r.stdout)) counts.set(l, (counts.get(l) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l]) => {
        const [name, email] = l.split(SEP);
        return { name, email };
      });
  },

  // ---- identity per folder (git's includeIf) ----
  // Gitline writes each rule's [user] block to its own file and includes it for repos under the folder.
  // Rules pointing anywhere else were set up by hand; they're listed but never changed.
  async identityRules() {
    const home = os.homedir();
    const r = await git(home, ['config', '--global', '--get-regexp', '^includeif\\.gitdir'], { allowFail: true });
    const rules = [];
    for (const line of lines(r.stdout)) {
      const sp = line.lastIndexOf(' ');
      const key = line.slice(0, sp);
      const file = line.slice(sp + 1);
      const m = key.match(/^includeif\.(gitdir(?:\/i)?):(.*)\.path$/i);
      if (!m) continue;
      const read = async (k) => (await git(home, ['config', '--file', expandHome(file), '--get', k], { allowFail: true })).stdout.trim();
      rules.push({ key, folder: m[2].replace(/\/$/, ''), name: await read('user.name'), email: await read('user.email'), managed: isManagedIdentity(file) });
    }
    return rules;
  },
  // Replaces every Gitline-managed rule with `rules` ({ folder, name, email }).
  async saveIdentityRules(_cwd, rules) {
    const home = os.homedir();
    for (const old of await ops.identityRules()) {
      if (old.managed) await git(home, ['config', '--global', '--unset-all', old.key], { allowFail: true });
    }
    fs.rmSync(IDENTITY_DIR(), { recursive: true, force: true });
    fs.mkdirSync(IDENTITY_DIR(), { recursive: true });
    for (const [i, rule] of rules.entries()) {
      const folder = rule.folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!folder || (!rule.name.trim() && !rule.email.trim())) continue;
      const file = path.join(IDENTITY_DIR(), `${i + 1}-${folder.split('/').pop() || 'root'}.gitconfig`).replace(/\\/g, '/');
      if (rule.name.trim()) await git(home, ['config', '--file', file, 'user.name', rule.name.trim()]);
      if (rule.email.trim()) await git(home, ['config', '--file', file, 'user.email', rule.email.trim()]);
      // Trailing slash = everything under the folder; Windows paths compare case-insensitively.
      const cond = `${process.platform === 'win32' ? 'gitdir/i' : 'gitdir'}:${folder}/`;
      await git(home, ['config', '--global', '--add', `includeIf.${cond}.path`, file]);
    }
  },
  // Which name/email a repo will actually commit with, and where it comes from.
  async effectiveIdentity(cwd) {
    const get = async (k) => (await git(cwd, ['config', '--show-origin', '--get', k], { allowFail: true })).stdout.trim();
    const [n, e] = await Promise.all([get('user.name'), get('user.email')]);
    const split = (s) => {
      const tab = s.indexOf('\t');
      return tab < 0 ? { value: '', origin: '' } : { origin: s.slice(0, tab).replace(/^file:/, ''), value: s.slice(tab + 1) };
    };
    return { name: split(n), email: split(e) };
  },

  // ---- GitHub (via the gh CLI) ----
  async ghStatus(cwd) {
    const remotes = (await git(cwd, ['remote', '-v'])).stdout;
    if (!/github\.com[:/]/.test(remotes)) return { ok: false, reason: 'No GitHub remote' };
    try {
      await gh(cwd, ['auth', 'status', '--hostname', 'github.com']);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: /not installed/.test(e.message) ? e.message : 'Not signed in to GitHub. Run `gh auth login` in a terminal.' };
    }
  },
  async ghPrs(cwd) {
    const fields = 'number,title,headRefName,baseRefName,author,url,isDraft,reviewDecision,statusCheckRollup,isCrossRepository';
    const out = await gh(cwd, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields]);
    return JSON.parse(out).map((p) => ({
      number: p.number,
      title: p.title,
      head: p.headRefName,
      base: p.baseRefName,
      author: p.author?.login ?? '',
      url: p.url,
      draft: p.isDraft,
      review: p.reviewDecision || null,
      fork: p.isCrossRepository,
      checks: summarizeChecks(p.statusCheckRollup ?? []),
    }));
  },
  // GitHub Actions results for recent commits: one state per commit, failing if any run failed.
  async ghCiStatus(cwd) {
    const out = await gh(cwd, ['run', 'list', '--limit', '200', '--json', 'headSha,status,conclusion,url,name']);
    const bySha = {};
    for (const r of JSON.parse(out)) {
      const state =
        r.status !== 'completed' ? 'pending' : ['success', 'skipped', 'neutral'].includes(r.conclusion) ? 'success' : r.conclusion === 'cancelled' ? null : 'failure';
      if (!state) continue;
      const cur = bySha[r.headSha];
      const rank = { failure: 3, pending: 2, success: 1 };
      if (!cur || rank[state] > rank[cur.state]) bySha[r.headSha] = { state, url: r.url, name: r.name };
    }
    return bySha;
  },
  async ghCreatePr(cwd, head, base, title, body, draft) {
    const out = await gh(cwd, ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body ?? '', ...(draft ? ['--draft'] : [])]);
    return out.trim().split('\n').pop();
  },
  async ghCheckoutPr(cwd, number) {
    await gh(cwd, ['pr', 'checkout', String(number)]);
  },
  // Repositories the signed-in GitHub user can clone: their own, ones they collaborate on, and their orgs'.
  // Runs from the home folder because it doesn't belong to any repo.
  async ghMyRepos() {
    const out = await gh(os.homedir(), [
      'api',
      'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
      '--jq',
      '[.[] | {name: .full_name, description: .description, private: .private, url: .clone_url, updated: .updated_at}]',
    ]);
    return JSON.parse(out);
  },
  async ghDefaultBranch(cwd) {
    try {
      return (await gh(cwd, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim() || null;
    } catch {
      return null;
    }
  },

  // ---- tags ----
  async createTag(cwd, name, sha, message) {
    if (message) await git(cwd, ['tag', '-a', name, '-m', message, sha]);
    else await git(cwd, ['tag', name, sha]);
  },
  async deleteTag(cwd, name) {
    await git(cwd, ['tag', '-d', name]);
  },
  async pushTag(cwd, remote, name) {
    await git(cwd, ['push', remote, `refs/tags/${name}`]);
  },

  // ---- stash ----
  // `paths` stashes just those files; `stagedOnly` stashes just what's in the index.
  async stash(cwd, message, paths, stagedOnly) {
    const m = message ? ['-m', message] : [];
    if (stagedOnly) await git(cwd, ['stash', 'push', '--staged', ...m]);
    else await git(cwd, ['stash', 'push', '-u', ...m, ...(paths?.length ? ['--', ...paths] : [])]);
  },
  stashApply: (cwd, ref) => conflictAware(cwd, ['stash', 'apply', ref]),
  stashPop: (cwd, ref) => conflictAware(cwd, ['stash', 'pop', ...(ref ? [ref] : [])]),
  async stashDrop(cwd, ref) {
    await git(cwd, ['stash', 'drop', ref]);
  },

  // ---- remotes ----
  // Fetches everything and reports remote branches that gained commits from other people.
  async fetch(cwd) {
    const snapshot = async () =>
      new Map(lines((await git(cwd, ['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/remotes'])).stdout).map((l) => l.split(SEP)));
    const before = await snapshot();
    await git(cwd, ['fetch', '--all', '--prune', '--tags']);
    const after = await snapshot();
    // First fetch of a fresh clone: everything is "new", which isn't news.
    if (!before.size) return [];
    const me = (await git(cwd, ['config', 'user.email'], { allowFail: true })).stdout.trim().toLowerCase();
    const report = [];
    for (const [ref, sha] of after) {
      const old = before.get(ref);
      if (old === sha || ref.endsWith('/HEAD')) continue;
      // A new branch only counts commits that aren't on any other remote branch.
      const others = [...after].filter(([r]) => r !== ref).map(([, v]) => v);
      const range = old ? [`${old}..${sha}`] : [sha, '--not', ...before.values(), ...others];
      const r = await git(cwd, ['log', '-n', '500', '--format=%an%x1f%ae', ...range, '--'], { allowFail: true });
      const theirs = lines(r.stdout)
        .map((l) => l.split(SEP))
        .filter(([, email]) => email.toLowerCase() !== me);
      if (theirs.length) report.push({ ref: ref.replace(/^refs\/remotes\//, ''), count: theirs.length, authors: [...new Set(theirs.map(([name]) => name))], isNew: !old });
    }
    return report;
  },
  pull(cwd, mode) {
    const flag = { ff: '--no-rebase', 'ff-only': '--ff-only', rebase: '--rebase' }[mode] || '--no-rebase';
    return conflictAware(cwd, ['pull', flag]);
  },
  async push(cwd, branch, force) {
    const cur = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
    branch = branch || cur;
    if (!branch) throw new Error('You are in a detached HEAD state. Create a branch before pushing.');
    const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`], { allowFail: true });
    const f = force ? ['--force-with-lease'] : [];
    if (up.code === 0) {
      const [remote, ...rest] = up.stdout.trim().split('/');
      await git(cwd, ['push', ...f, remote, `${branch}:${rest.join('/')}`]);
      return { setUpstream: false };
    }
    const remotes = lines((await git(cwd, ['remote'])).stdout);
    if (!remotes.length) throw new Error('This repository has no remotes. Add one from the REMOTE section in the sidebar.');
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    await git(cwd, ['push', ...f, '-u', remote, branch]);
    return { setUpstream: true, remote };
  },
  async addRemote(cwd, name, url) {
    await git(cwd, ['remote', 'add', name, url]);
  },
  async removeRemote(cwd, name) {
    await git(cwd, ['remote', 'remove', name]);
  },

  // ---- repo lifecycle (cwd is the parent / target directory) ----
  async clone(parent, url, name) {
    await git(parent, ['clone', '--', url, name]);
    return path.join(parent, name);
  },
  async init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '-q']);
    return dir;
  },
};

module.exports = { ops };
