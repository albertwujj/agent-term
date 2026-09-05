const assert = require('assert');
const { NOTICE_DWELL_MS, shouldNoticeAltScreen, altScreenNotice } = require('../src/alt-screen-notice');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) { testsFailed++; console.log(`  ✗ ${name}`); console.log(`      ${err.message}`); }
}

console.log('alt-screen-notice');

test('an alt-screen Claude Code is worth saying once', () => {
  assert.strictEqual(shouldNoticeAltScreen({ cli: 'claude', bufferType: 'alternate' }), true);
});

test('the normal buffer is the case this terminal is built for', () => {
  assert.strictEqual(shouldNoticeAltScreen({ cli: 'claude', bufferType: 'normal' }), false);
});

test('it is said once, not on every switch back and forth', () => {
  assert.strictEqual(
    shouldNoticeAltScreen({ cli: 'claude', bufferType: 'alternate', alreadyNoticed: true }), false);
});

// vim, less and htop live on the alternate screen legitimately, and a shell
// window running one is not a session whose conversation we have lost.
test('a shell with no AI CLI is left alone', () => {
  for (const cli of [null, undefined, '']) {
    assert.strictEqual(shouldNoticeAltScreen({ cli, bufferType: 'alternate' }), false, String(cli));
  }
});

// The other CLIs lose the same reach and have no /tui to offer, so a notice
// would be a complaint rather than help.
test('only the CLI with somewhere to send the user is noticed', () => {
  for (const cli of ['codex', 'copilot', 'agent']) {
    assert.strictEqual(shouldNoticeAltScreen({ cli, bufferType: 'alternate' }), false, cli);
  }
});

test('missing arguments never throw', () => {
  assert.strictEqual(shouldNoticeAltScreen(), false);
  assert.strictEqual(shouldNoticeAltScreen({}), false);
});

test('the notice names the loss and the way back', () => {
  const text = altScreenNotice();
  assert.ok(/\/tui default/.test(text), text);
  assert.ok(/comment/i.test(text), text);
  assert.ok(NOTICE_DWELL_MS >= 5000, 'dwell must outlast a glance at less');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
