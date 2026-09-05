const assert = require('assert');
const { aiCliRendererEnv } = require('../src/cli-renderer-env');

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

console.log('cli-renderer-env');

test('a shell we spawn asks for the classic renderer', () => {
  assert.deepStrictEqual(aiCliRendererEnv({}), { CLAUDE_CODE_NO_FLICKER: '0' });
  assert.deepStrictEqual(aiCliRendererEnv({ PATH: '/usr/bin' }), { CLAUDE_CODE_NO_FLICKER: '0' });
});

// NO_FLICKER=0 and DISABLE_ALTERNATE_SCREEN=1 both outrank a saved `tui`
// setting, but only NO_FLICKER is cleared by /tui when it relaunches — so the
// user can still reach fullscreen from inside a session we started.
test('it asks with the variable /tui can clear, not the one that outlives it', () => {
  assert.deepStrictEqual(Object.keys(aiCliRendererEnv({})), ['CLAUDE_CODE_NO_FLICKER']);
});

test('an explicit choice of either variable is left alone', () => {
  for (const env of [
    { CLAUDE_CODE_NO_FLICKER: '1' },
    { CLAUDE_CODE_NO_FLICKER: '0' },
    { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
    { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
  ]) {
    assert.deepStrictEqual(aiCliRendererEnv(env), {}, JSON.stringify(env));
  }
});

// An empty string is how an unset variable arrives through some launchers;
// it is not a choice, so it does not silence us.
test('an empty value is not a choice', () => {
  assert.deepStrictEqual(aiCliRendererEnv({ CLAUDE_CODE_NO_FLICKER: '' }),
    { CLAUDE_CODE_NO_FLICKER: '0' });
});

test('the parent environment is never mutated', () => {
  const env = {};
  aiCliRendererEnv(env);
  assert.deepStrictEqual(env, {});
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
