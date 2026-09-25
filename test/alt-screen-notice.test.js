const assert = require('assert');
const { NOTICE_DWELL_MS, shouldNoticeAltScreen, altScreenNotice } = require('../src/alt-screen-notice');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) { testsFailed++; console.log(`  ✗ ${name}`); console.log(`      ${err.message}`); }
}

console.log('alt-screen-notice');

test('an alt-screen Claude Code or Codex is worth saying once', () => {
  for (const cli of ['claude', 'codex']) {
    assert.strictEqual(shouldNoticeAltScreen({ cli, bufferType: 'alternate' }), true);
  }
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

// The other CLIs lose the same reach and have no known way back to offer.
test('only CLIs with somewhere to send the user are noticed', () => {
  for (const cli of ['copilot', 'agent']) {
    assert.strictEqual(shouldNoticeAltScreen({ cli, bufferType: 'alternate' }), false, cli);
  }
});

test('missing arguments never throw', () => {
  assert.strictEqual(shouldNoticeAltScreen(), false);
  assert.strictEqual(shouldNoticeAltScreen({}), false);
});

test('the notice names the loss and the way back', () => {
  const claudeText = altScreenNotice('claude');
  const codexText = altScreenNotice('codex');
  assert.ok(/\/tui default/.test(claudeText), claudeText);
  assert.ok(/codex --no-alt-screen/.test(codexText), codexText);
  assert.ok(/comment/i.test(claudeText), claudeText);
  assert.ok(/comment/i.test(codexText), codexText);
  assert.ok(NOTICE_DWELL_MS >= 5000, 'dwell must outlast a glance at less');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
