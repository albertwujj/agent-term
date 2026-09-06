const assert = require('assert');
const {
  BARE_REFERENCE,
  DICTATION_CLAUSE,
  GUIDE_MISSING_FIRST,
  GUIDE_MISSING_AGAIN,
  voicePromptPrefix,
} = require('../src/voice-prompt');

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

console.log('voice-prompt');

test('a resolved guide is named, with nothing else in the way', () => {
  const { prefix, warned } = voicePromptPrefix({ resolvedPath: '/Users/x/voice-to-agent/interpret.md' });
  assert.strictEqual(prefix, '[/Users/x/voice-to-agent/interpret.md]');
  assert.strictEqual(warned, false, 'a working guide never arms the warning');
});

test('a resolved guide stays quiet even after an earlier warning', () => {
  // The self-healing case: the user read the warning and cloned the kit, so
  // the next utterance resolves and must not carry the notice.
  const { prefix } = voicePromptPrefix({ resolvedPath: '/tmp/voice-to-agent/interpret.md', warned: true });
  assert.strictEqual(prefix, '[/tmp/voice-to-agent/interpret.md]');
});

test('the first miss warns at length and still sends the reference', () => {
  const { prefix, warned } = voicePromptPrefix({ resolvedPath: null, warned: false });
  assert.strictEqual(prefix, `${GUIDE_MISSING_FIRST}\n${BARE_REFERENCE}`);
  assert.strictEqual(warned, true);
});

test('later misses drop to a notice', () => {
  const { prefix, warned } = voicePromptPrefix({ resolvedPath: null, warned: true });
  assert.strictEqual(prefix, `${GUIDE_MISSING_AGAIN}\n${BARE_REFERENCE}`);
  assert.strictEqual(warned, true);
});

test('the repeat carries the operative clause and drops the meta', () => {
  // What the text is and how to read it has to hold on every turn. Where the
  // host looked, and how to fix it, were the first message's business.
  assert.ok(/dictated speech/.test(GUIDE_MISSING_AGAIN), 'what the text is');
  assert.ok(/repair it/.test(GUIDE_MISSING_AGAIN), 'what to do with it');
  assert.ok(/ask rather than guess/.test(GUIDE_MISSING_AGAIN), 'when not to act');
  assert.ok(!/github\.com/.test(GUIDE_MISSING_AGAIN), 'no URL on the repeat');
  assert.ok(!/home directory/.test(GUIDE_MISSING_AGAIN), 'no where-we-looked on the repeat');
  assert.ok(GUIDE_MISSING_AGAIN.length < GUIDE_MISSING_FIRST.length / 2, 'less than half as long');
});

test('both forms carry the dictation clause word for word', () => {
  assert.ok(GUIDE_MISSING_FIRST.includes(DICTATION_CLAUSE), 'the long form contains it');
  assert.strictEqual(GUIDE_MISSING_AGAIN, `[Notice from terminal host] ${DICTATION_CLAUSE}`,
    'the repeat is the clause and nothing else');
});

test('severity drops from Warning to Notice, matching the host envelope', () => {
  assert.ok(GUIDE_MISSING_FIRST.startsWith('[Warning from terminal host]'));
  assert.ok(GUIDE_MISSING_AGAIN.startsWith('[Notice from terminal host]'));
});

test('the transcript is never part of the prefix', () => {
  // The guide defines the text after the reference as the transcript, so the
  // reference has to be the last line the host contributes.
  for (const warned of [false, true]) {
    const { prefix } = voicePromptPrefix({ resolvedPath: null, warned });
    assert.ok(prefix.endsWith(BARE_REFERENCE), 'reference sits last');
  }
  const { prefix } = voicePromptPrefix({ resolvedPath: '/a/voice-to-agent/interpret.md' });
  assert.ok(prefix.endsWith(']'), 'resolved reference sits last');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
