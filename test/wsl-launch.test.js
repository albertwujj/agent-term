const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { requireSourceStartCwd } = require('../src/source-start-cwd');
const {
  bashLauncher,
  configuredWslDistro,
  wslCommandArgs,
  wslShellArgs,
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

test('Windows accepts the WSL path validated by its source launcher', () => {
  assert.strictEqual(
    requireSourceStartCwd('win32', { AGENT_TERM_START_CWD: '/home/me/primary' }),
    '/home/me/primary',
  );
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
