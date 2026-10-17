// Thin wrapper around the git CLI. Every op takes the repo path as its first argument.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SEP = '\x1f';
const REC = '\x1e';

const ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_OPTIONAL_LOCKS: '0',
};

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, env: ENV, maxBuffer: 512 * 1024 * 1024 },
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
    const p = spawn('git', args, { cwd, env: ENV });
    let out = '';
    let errOut = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((errOut || out).trim()))));
    p.stdin.end(input);
  });
}

// Runs an op that may stop on conflicts (merge, rebase, cherry-pick, ...).
async function conflictAware(cwd, args) {
  const r = await git(cwd, args, { allowFail: true });
  const text = r.stdout + r.stderr;
  if (r.code === 0) return { conflict: false, output: text.trim() };
  if (/CONFLICT|could not apply|after resolving the conflicts/i.test(text)) return { conflict: true, output: text.trim() };
  throw new Error(text.trim());
}

const exists = (...p) => fs.existsSync(path.join(...p));
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
    return {
      head: head.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
      state,
      mergeMsg,
      remotes: lines(remotes.stdout),
    };
  },

  async log(cwd, limit = 5000) {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';
    const r = await git(
      cwd,
      ['log', '--exclude=refs/stash', '--all', '--date-order', '-n', String(limit), `--pretty=format:${fmt}`],
      { allowFail: true }
    );
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

  async diffWorking(cwd, file, staged, untracked, oldPath) {
    if (untracked) {
      return (await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file], { allowFail: true })).stdout;
    }
    const args = ['diff', '--no-ext-diff', '-M'];
    if (staged) args.push('--cached');
    args.push('--', ...(oldPath ? [oldPath, file] : [file]));
    return (await git(cwd, args)).stdout;
  },

  async diffCommit(cwd, sha, file, oldPath, parent) {
    const paths = oldPath ? [oldPath, file] : [file];
    if (parent) return (await git(cwd, ['diff', '--no-ext-diff', '-M', parent, sha, '--', ...paths])).stdout;
    return (await git(cwd, ['show', '--no-ext-diff', '--format=', '-M', sha, '--', ...paths])).stdout;
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
    const args = ['apply', '--whitespace=nowarn'];
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
  async stash(cwd, message) {
    await git(cwd, ['stash', 'push', '-u', ...(message ? ['-m', message] : [])]);
  },
  stashApply: (cwd, ref) => conflictAware(cwd, ['stash', 'apply', ref]),
  stashPop: (cwd, ref) => conflictAware(cwd, ['stash', 'pop', ...(ref ? [ref] : [])]),
  async stashDrop(cwd, ref) {
    await git(cwd, ['stash', 'drop', ref]);
  },

  // ---- remotes ----
  async fetch(cwd) {
    await git(cwd, ['fetch', '--all', '--prune', '--tags']);
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
