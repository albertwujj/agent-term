// Where the stream client reads ~/.agent-term/config.json: the home on
// macOS, the WSL home through \\wsl.localhost on Windows, and nothing on a
// Windows start the WSL launcher did not make.

const assert = require('assert');
const { userConfigPath, hubUrlProblem } = require('../src/stream/config');

let testsPassed = 0, testsFailed = 0;
function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) { testsFailed++; console.log(`  ✗ ${name}`); console.log(`      ${err.message}`); }
}

console.log('stream-config-path');

test('macOS: the user home', () => {
  assert.strictEqual(userConfigPath({ platform: 'darwin', env: {}, homedir: '/Users/me' }), '/Users/me/.agent-term/config.json');
});

test('Windows from the WSL launcher: the WSL home, by UNC', () => {
  assert.strictEqual(
    userConfigPath({ platform: 'win32', env: { AGENT_TERM_DISTRO: 'Ubuntu', AGENT_TERM_WSL_HOME: '/home/me' }, homedir: 'C:\\Users\\me' }),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\.agent-term\\config.json');
});

test('Windows: WSL_DISTRO_NAME serves when the launcher name is absent', () => {
  assert.strictEqual(
    userConfigPath({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Debian', AGENT_TERM_WSL_HOME: '/home/me/' }, homedir: 'C:\\Users\\me' }),
    '\\\\wsl.localhost\\Debian\\home\\me\\.agent-term\\config.json');
});

test('Windows without the launcher: no file, never the Windows home', () => {
  assert.strictEqual(userConfigPath({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me' }), null);
  assert.strictEqual(userConfigPath({ platform: 'win32', env: { AGENT_TERM_DISTRO: 'Ubuntu' }, homedir: 'C:\\Users\\me' }), null);
});

test('hub address: https passes, plain http only to this machine', () => {
  assert.strictEqual(hubUrlProblem('https://stream.example.com'), null);
  assert.strictEqual(hubUrlProblem('http://localhost:8787'), null);
  assert.strictEqual(hubUrlProblem('http://127.0.0.1:8787'), null);
  assert.strictEqual(hubUrlProblem('http://[::1]:8787'), null);
  assert.strictEqual(hubUrlProblem('http://hub.localhost'), null);
});

test('hub address: plain http elsewhere is refused, naming only the origin', () => {
  const problem = hubUrlProblem('http://user:pw@stream.example.com/path?token=x');
  assert.match(problem, /refused: use an https address/);
  assert.match(problem, /http:\/\/stream\.example\.com/);
  assert.doesNotMatch(problem, /pw|token/);
  assert.match(hubUrlProblem('http://192.168.1.5:8787'), /refused/);
  assert.match(hubUrlProblem('ws://stream.example.com'), /refused/);
  assert.match(hubUrlProblem('not a url'), /not a valid URL/);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
