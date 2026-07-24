// Tests for src/gui-session.js — the compositor-session stamp that lets the
// active-file liveness check spot a window that died with its WindowServer.

const assert = require('assert');
const guiSession = require('../src/gui-session');

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

console.log('\ngui-session tests\n');

if (process.platform === 'darwin') {
  test('readGuiSession returns a WindowServer stamp on macOS', () => {
    const value = guiSession.readGuiSession();
    assert.ok(typeof value === 'string' && /^ws:\d+:\S/.test(value), `unexpected stamp: ${value}`);
  });

  test('the stamp is stable while the compositor session is', () => {
    guiSession.resetCache();
    assert.strictEqual(guiSession.readGuiSession(), guiSession.readGuiSession());
  });

  test('currentGuiSession caches within the TTL', () => {
    guiSession.resetCache();
    const first = guiSession.currentGuiSession();
    // A zero-length TTL would re-probe; the default must not.
    assert.strictEqual(guiSession.currentGuiSession(), first);
  });
} else {
  // Windows/Linux: nothing is stamped, so liveness stays pid + bootTime and
  // no process is spawned to work that out.
  test('no stamp off macOS', () => {
    assert.strictEqual(guiSession.readGuiSession(), null);
    assert.strictEqual(guiSession.currentGuiSession(), null);
  });
}

test('resetCache forces a fresh read', () => {
  const before = guiSession.currentGuiSession();
  guiSession.resetCache();
  assert.strictEqual(guiSession.currentGuiSession(), before);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed\n`);
process.exit(testsFailed > 0 ? 1 : 0);
