// A stand-in for the GitHub CLI, so tests never touch a real GitHub account. The app runs it when
// GITLINE_GH points here. It answers from the JSON fixture at GITLINE_GH_FIXTURE and appends each call
// (its arguments, and stdin for `--body-file -`) as a JSON line to GITLINE_GH_LOG.
//
// Fixture: { user, prs: [gh pr list items], pr: gh pr view output, fail: { 'pr merge': 'message' } }
const fs = require('fs');

const args = process.argv.slice(2);
const fixture = (() => {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITLINE_GH_FIXTURE, 'utf8'));
  } catch {
    return {};
  }
})();

function finish(stdin) {
  if (process.env.GITLINE_GH_LOG) fs.appendFileSync(process.env.GITLINE_GH_LOG, JSON.stringify({ args, stdin }) + '\n');
  const fail = (msg) => {
    process.stderr.write(msg + '\n');
    process.exit(1);
  };
  const out = (s) => process.stdout.write(s + '\n');
  const cmd = args.slice(0, 2).join(' ');
  if (fixture.fail?.[cmd]) return fail(fixture.fail[cmd]);
  if (!fixture.user) return fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  switch (cmd) {
    case 'auth status':
      return out(`Logged in to github.com account ${fixture.user}`);
    case 'api user':
      return out(fixture.user);
    case 'pr list':
      return out(JSON.stringify(fixture.prs ?? []));
    case 'pr view':
      return out(JSON.stringify(fixture.pr ?? {}));
    case 'run list':
      return out('[]');
    case 'repo view':
      return out('main');
    case 'pr create':
      return out('https://github.com/example/repo/pull/99');
    case 'pr merge':
    case 'pr close':
    case 'pr reopen':
    case 'pr ready':
    case 'pr comment':
    case 'pr review':
    case 'pr edit':
    case 'pr checkout':
      return;
    default:
      if (args[0] === 'api') return out('[]');
      return fail(`fake gh: unknown command: ${args.join(' ')}`);
  }
}

if (args.includes('--body-file') && args[args.indexOf('--body-file') + 1] === '-') {
  let stdin = '';
  process.stdin.on('data', (d) => (stdin += d));
  process.stdin.on('end', () => finish(stdin));
} else finish(null);
