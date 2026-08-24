const assert = require('assert');
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
});

test('interactive development shell opens in the native-WSL checkout', () => {
  const env = {
    AGENT_TERM_WSL_DISTRO: 'Ubuntu',
    AGENT_TERM_WSL_CWD: '/home/me/src/agent-term',
  };
  assert.deepStrictEqual(
    wslShellArgs(env),
    ['--distribution', 'Ubuntu', '--cd', '/home/me/src/agent-term'],
  );
});

test('a configured cwd can target the default distro', () => {
  assert.deepStrictEqual(
    wslShellArgs({ AGENT_TERM_WSL_CWD: ' /work/agent-term ' }),
    ['--cd', '/work/agent-term'],
  );
});

test('non-Windows bash launcher remains native', () => {
  assert.deepStrictEqual(
    bashLauncher('linux', { AGENT_TERM_WSL_DISTRO: 'Ubuntu' }),
    ['bash'],
  );
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
