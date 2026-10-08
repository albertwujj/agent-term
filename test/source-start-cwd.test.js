const assert = require('assert');
const { sourceLaunchEnv } = require('../src/source-start-cwd');

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

console.log('source-start-cwd');

const fsApi = { statSync: () => ({ isDirectory: () => true }) };

test("npm's directory becomes the start directory, over an inherited one", () => {
  const env = { INIT_CWD: '/work/here', AGENT_TERM_START_CWD: '/work/elsewhere', HOME: '/home/me' };
  assert.deepStrictEqual(sourceLaunchEnv(env, 'darwin', fsApi),
    { INIT_CWD: '/work/here', AGENT_TERM_START_CWD: '/work/here', HOME: '/home/me' });
});

test('without INIT_CWD nothing is overridden', () => {
  const env = { AGENT_TERM_START_CWD: '/work/elsewhere' };
  assert.strictEqual(sourceLaunchEnv(env, 'darwin', fsApi), env);
});

test('the parent environment is never mutated', () => {
  const env = { INIT_CWD: '/work/here', AGENT_TERM_START_CWD: '/work/elsewhere' };
  sourceLaunchEnv(env, 'darwin', fsApi);
  assert.deepStrictEqual(env, { INIT_CWD: '/work/here', AGENT_TERM_START_CWD: '/work/elsewhere' });
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
