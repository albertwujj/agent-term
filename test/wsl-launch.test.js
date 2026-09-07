const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { requireSourceStartCwd, sourceLaunchEnv } = require('../src/source-start-cwd');
const {
  bashLauncher,
  configuredWslDistro,
  wslCommandArgs,
  wslShellArgs,
  wslenvForPty,
} = require('../src/wsl-launch');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('wsl-launch');

test('installed Windows behavior keeps the default distro and cwd', () => {
  assert.strictEqual(configuredWslDistro({}), '');
  assert.deepStrictEqual(wslCommandArgs(['cat', '/tmp/x'], {}), ['cat', '/tmp/x']);
  assert.deepStrictEqual(wslShellArgs({}), []);
  assert.deepStrictEqual(bashLauncher('win32', {}), ['wsl', 'bash']);
});

test('WSL development commands stay in the invoking distro', () => {
  const env = { AGENT_TERM_WSL_DISTRO: 'Ubuntu-24.04' };
  assert.deepStrictEqual(
    wslCommandArgs(['readlink', '/proc/42/cwd'], env),
    ['--distribution', 'Ubuntu-24.04', '--exec', 'readlink', '/proc/42/cwd'],
  );
  assert.deepStrictEqual(
    bashLauncher('win32', env),
    ['wsl', '--distribution', 'Ubuntu-24.04', '--exec', 'bash'],
  );
  assert.deepStrictEqual(
    wslShellArgs(env),
    ['--distribution', 'Ubuntu-24.04'],
  );
});

test('the npm invocation directory is passed to the WSL shell', () => {
  const env = {
    AGENT_TERM_WSL_DISTRO: 'Ubuntu',
    AGENT_TERM_START_CWD: '/home/me/primary',
  };
  assert.deepStrictEqual(
    wslShellArgs(env),
    ['--distribution', 'Ubuntu', '--cd', '/home/me/primary'],
  );
});

test('a configured cwd with spaces can target the default distro', () => {
  assert.deepStrictEqual(
    wslShellArgs({ AGENT_TERM_START_CWD: '/work/primary project' }),
    ['--cd', '/work/primary project'],
  );
});

test('non-Windows bash launcher remains native', () => {
  assert.deepStrictEqual(
    bashLauncher('linux', { AGENT_TERM_WSL_DISTRO: 'Ubuntu' }),
    ['bash'],
  );
});

function runShellCwdCheck(initCwd) {
  const env = { ...process.env };
  delete env.INIT_CWD;
  if (initCwd !== undefined) env.INIT_CWD = initCwd;
  return spawnSync(
    'bash',
    ['-c', 'set -e; source "$1"; agent_term_require_source_start_cwd; printf "%s" "$AGENT_TERM_START_CWD"',
      'source-start-cwd-test', path.join(__dirname, '..', 'scripts', 'source-start-cwd.sh')],
    { encoding: 'utf8', env },
  );
}

test('source launcher exports INIT_CWD as the startup directory', () => {
  const result = runShellCwdCheck(__dirname);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, __dirname);
});

test('source launcher fails when npm did not provide INIT_CWD', () => {
  const result = runShellCwdCheck();
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /requires npm's INIT_CWD/);
});

test('native source launch uses npm INIT_CWD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-start-cwd-'));
  try {
    assert.strictEqual(requireSourceStartCwd('darwin', { INIT_CWD: root }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source launch rejects a missing or relative directory', () => {
  assert.throws(
    () => requireSourceStartCwd('darwin', {}),
    /source launch has no startup directory.*--prefix/,
  );
  assert.throws(
    () => requireSourceStartCwd('darwin', { AGENT_TERM_START_CWD: 'primary' }),
    /not absolute/,
  );
  assert.throws(
    () => requireSourceStartCwd('darwin', { AGENT_TERM_START_CWD: '/definitely/missing/agent-term-cwd' }),
    /does not exist/,
  );
});

test('source launch rejects a native path that is not a directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-start-cwd-'));
  const file = path.join(root, 'file');
  try {
    fs.writeFileSync(file, 'x');
    assert.throws(
      () => requireSourceStartCwd('darwin', { AGENT_TERM_START_CWD: file }),
      /not a directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a source launch hands the child npm\'s directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-launch-env-'));
  try {
    const env = sourceLaunchEnv({ PATH: '/usr/bin', INIT_CWD: root }, 'darwin');
    assert.strictEqual(env.AGENT_TERM_START_CWD, root);
    assert.strictEqual(env.PATH, '/usr/bin', 'the rest of the environment rides along');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm\'s directory beats one inherited from the window it was typed in', () => {
  // The case: an agent inside an AgentTerm session runs `npm --prefix … run
  // start` from the project it is setting up. Every shell in a window carries
  // that window's AGENT_TERM_START_CWD, and preferring it would open the new
  // window on the parent session's directory instead.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-project-'));
  try {
    const env = sourceLaunchEnv(
      { INIT_CWD: project, AGENT_TERM_START_CWD: '/somewhere/the/parent/session/started' },
      'darwin',
    );
    assert.strictEqual(env.AGENT_TERM_START_CWD, project);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('without npm nothing is overridden, so a hand-run script behaves as before', () => {
  const inherited = { AGENT_TERM_START_CWD: '/home/me/session-repo' };
  assert.strictEqual(sourceLaunchEnv(inherited, 'darwin'), inherited);
});

test('a source launch refuses an INIT_CWD it cannot use', () => {
  assert.throws(() => sourceLaunchEnv({ INIT_CWD: 'relative' }, 'darwin'), /not absolute/);
  assert.throws(
    () => sourceLaunchEnv({ INIT_CWD: '/definitely/missing/agent-term-cwd' }, 'darwin'),
    /does not exist/,
  );
});

test('Windows accepts the WSL path validated by its source launcher', () => {
  assert.strictEqual(
    requireSourceStartCwd('win32', { AGENT_TERM_START_CWD: '/home/me/primary' }),
    '/home/me/primary',
  );
});

// The pty's WSLENV. Windows-only behaviour, asserted from any OS because the
// platform is an argument rather than something read from the process — the
// same reason bashLauncher('win32', …) above can be checked here.
test('off Windows there is no boundary to cross, so no key is set', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepStrictEqual(wslenvForPty(platform, { WSLENV: 'INHERITED' }, ['A']), {}, platform);
  }
});

test('the names we set are appended to what we inherited', () => {
  assert.deepStrictEqual(
    wslenvForPty('win32', { WSLENV: 'AGENT_TERM_DISTRO' }, ['AGENT_SESSION_ID', 'TERM_PROGRAM']),
    { WSLENV: 'AGENT_TERM_DISTRO:AGENT_SESSION_ID:TERM_PROGRAM' },
  );
});

// A leading separator is an empty variable name, which is what an absent or
// empty inherited value would produce if it were joined in blindly.
test('an absent or empty inherited value never leaves a stray separator', () => {
  assert.deepStrictEqual(wslenvForPty('win32', {}, ['A', 'B']), { WSLENV: 'A:B' });
  assert.deepStrictEqual(wslenvForPty('win32', { WSLENV: '' }, ['A']), { WSLENV: 'A' });
  assert.deepStrictEqual(wslenvForPty('win32', { WSLENV: ':A::' }, ['B']), { WSLENV: 'A:B' });
});

// A window opened from another window inherits a WSLENV that already lists
// ours; appending again would grow the value on every nesting.
test('a name already listed is not added twice', () => {
  assert.deepStrictEqual(
    wslenvForPty('win32', { WSLENV: 'AGENT_SESSION_ID:TERM_PROGRAM' },
      ['AGENT_SESSION_ID', 'TERM_PROGRAM', 'CLAUDE_CODE_NO_FLICKER']),
    { WSLENV: 'AGENT_SESSION_ID:TERM_PROGRAM:CLAUDE_CODE_NO_FLICKER' },
  );
});

// An entry may carry path-translation flags after a slash; the name is the
// part before it, and the inherited entry keeps its flags.
test('an inherited entry keeps its flags and still counts as listed', () => {
  assert.deepStrictEqual(
    wslenvForPty('win32', { WSLENV: 'AGENT_TERM_SOURCE_WIN/p:AGENT_SESSION_ID' },
      ['AGENT_SESSION_ID', 'TERM_PROGRAM']),
    { WSLENV: 'AGENT_TERM_SOURCE_WIN/p:AGENT_SESSION_ID:TERM_PROGRAM' },
  );
});

// Nothing set means nothing to share, which is what an opted-out renderer
// request looks like: aiCliRendererEnv returned {}, so its key is absent.
test('setting no variables of our own leaves the inherited value alone', () => {
  assert.deepStrictEqual(wslenvForPty('win32', { WSLENV: 'A' }, []), { WSLENV: 'A' });
  assert.deepStrictEqual(wslenvForPty('win32', {}, []), { WSLENV: '' });
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
