// Tests for src/session-identity.js — pure function, runs in Node.

const assert = require('assert');
const {
  identityFromPrompts,
  IDENTITY_MIN_LEN,
  IDENTITY_MAX_PROMPTS,
  IDENTITY_WINDOW_MS,
} = require('../src/session-identity');

let testsPassed = 0;
let testsFailed = 0;

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

const T0 = 1789080000000;
const p = (prompt, dt = 0) => ({ prompt, t: T0 + dt });

console.log('session-identity');

test('a first prompt long enough is the whole identity, complete at once', () => {
  const id = identityFromPrompts([p('please add retry logic to the uploader')]);
  assert.strictEqual(id.text, 'please add retry logic to the uploader');
  assert.strictEqual(id.prompts.length, 1);
  assert.strictEqual(id.complete, true);
});

test('a short first prompt alone is the identity so far, incomplete', () => {
  const id = identityFromPrompts([p('generate more')]);
  assert.strictEqual(id.text, 'generate more');
  assert.strictEqual(id.complete, false);
});

// The reported case: the first prompt names nothing; the second does.
test('a short first prompt takes the next one', () => {
  const id = identityFromPrompts([
    p('generate more'),
    p('also, stories site is down. check and bring it up', 100_000),
    p('what about the gems site', 400_000),
  ]);
  assert.strictEqual(id.text, 'generate more · also, stories site is down. check and bring it up');
  assert.deepStrictEqual(id.prompts.map(x => x.prompt), ['generate more', 'also, stories site is down. check and bring it up']);
  assert.strictEqual(id.complete, true);
});

test('the first prompt stays in front, so the icon letters never move', () => {
  const id = identityFromPrompts([p('fix bug'), p('the login one, on the settings page', 5000)]);
  assert.ok(id.text.startsWith('fix bug'));
});

test('short prompts keep joining until the minimum length', () => {
  const id = identityFromPrompts([p('fix bug'), p('do it now', 1000), p('the login one please', 2000)]);
  assert.strictEqual(id.text, 'fix bug · do it now · the login one please');
  assert.ok(id.text.length >= IDENTITY_MIN_LEN);
  assert.strictEqual(id.complete, true);
});

test('no more than IDENTITY_MAX_PROMPTS join, even below the minimum', () => {
  const id = identityFromPrompts([p('go on'), p('more', 1000), p('okay', 2000), p('and more please', 3000)]);
  assert.strictEqual(id.prompts.length, IDENTITY_MAX_PROMPTS);
  assert.strictEqual(id.text, 'go on · more · okay');
  assert.strictEqual(id.complete, true);
});

test('a prompt past the window never joins, and closes the identity', () => {
  const id = identityFromPrompts([p('generate more'), p('also, stories site is down', IDENTITY_WINDOW_MS + 1)]);
  assert.strictEqual(id.text, 'generate more');
  assert.strictEqual(id.complete, true);
});

test('a prompt just inside the window joins', () => {
  const id = identityFromPrompts([p('generate more'), p('also, stories site is down', IDENTITY_WINDOW_MS)]);
  assert.strictEqual(id.text, 'generate more · also, stories site is down');
});

test('the window is measured from the first prompt, not the previous one', () => {
  const id = identityFromPrompts([
    p('go on'),
    p('more', IDENTITY_WINDOW_MS - 1000),
    p('and the gems site too', IDENTITY_WINDOW_MS + 1000),
  ]);
  assert.strictEqual(id.text, 'go on · more');
  assert.strictEqual(id.complete, true);
});

test('empty and malformed entries are ignored', () => {
  const id = identityFromPrompts([null, { prompt: '' }, { t: 5 }, p('generate more')]);
  assert.strictEqual(id.text, 'generate more');
  assert.strictEqual(id.complete, false);
});

test('no prompts: empty text, incomplete', () => {
  const id = identityFromPrompts([]);
  assert.strictEqual(id.text, '');
  assert.strictEqual(id.complete, false);
});

test('feeding the identity its own prompts again reproduces it', () => {
  const first = identityFromPrompts([p('generate more'), p('also, stories site is down', 1000)]);
  const again = identityFromPrompts(first.prompts);
  assert.strictEqual(again.text, first.text);
  assert.strictEqual(again.complete, true);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
