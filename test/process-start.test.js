// Tests for src/process-start.js — when each live process started, which lets
// the registry tell a window from a later process given its pid.

const assert = require('assert');
const processStart = require('../src/process-start');

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

console.log('\nprocess-start tests\n');

test('parseElapsed reads every etime shape', () => {
  assert.strictEqual(processStart.parseElapsed('05:07'), 307);
  assert.strictEqual(processStart.parseElapsed('01:02:03'), 3723);
  assert.strictEqual(processStart.parseElapsed('2-01:02:03'), 2 * 86400 + 3723);
  assert.strictEqual(processStart.parseElapsed(' 49-01:53:37 '), 49 * 86400 + 6817);
  assert.strictEqual(processStart.parseElapsed('Do 20 Aug'), null);
});

test('parseProcessStarts maps each pid to now minus its elapsed time', () => {
  const now = 1_000_000_000;
  const starts = processStart.parseProcessStarts('    1 49-01:53:37\n33573       41:10\n  bad line\n', now);
  assert.strictEqual(starts.get(1), now - (49 * 86400 + 6817) * 1000);
  assert.strictEqual(starts.get(33573), now - 2470 * 1000);
  assert.strictEqual(starts.size, 2);
});

if (process.platform === 'darwin') {
  test('processStartTime finds this process within ps precision', () => {
    processStart.resetCache();
    const own = Date.now() - process.uptime() * 1000;
    const started = processStart.processStartTime(process.pid);
    assert.ok(typeof started === 'number' && Math.abs(started - own) < 2000, `started ${started} vs ${own}`);
  });

  test('a pid ps does not list is unknown', () => {
    assert.strictEqual(processStart.processStartTime(999999), null);
  });
} else {
  // Windows: no ps, so the registry judges records by pid alone.
  test('no start times off macOS', () => {
    assert.strictEqual(processStart.processStartTime(process.pid), null);
  });
}

console.log(`\n${testsPassed} passed, ${testsFailed} failed\n`);
process.exit(testsFailed > 0 ? 1 : 0);
