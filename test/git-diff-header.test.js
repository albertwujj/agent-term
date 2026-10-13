const assert = require('assert');
const { gitDiffSidePath } = require('../src/git-diff-header');

let testsPassed = 0;
let testsFailed = 0;
function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// `token` as printed at its first occurrence in `line`.
function side(line, token) {
  return gitDiffSidePath(line, line.indexOf(token), token);
}

console.log('git-diff-header');

test('both sides of a diff --git line name the file', () => {
  const line = 'diff --git a/reddit/essay.md b/reddit/essay.md';
  assert.strictEqual(side(line, 'a/reddit/essay.md'), 'reddit/essay.md');
  assert.strictEqual(side(line, 'b/reddit/essay.md'), 'reddit/essay.md');
});

test('the ---, +++ and Binary files lines name the file', () => {
  assert.strictEqual(side('--- a/docs/setup.md', 'a/docs/setup.md'), 'docs/setup.md');
  assert.strictEqual(side('+++ b/docs/setup.md', 'b/docs/setup.md'), 'docs/setup.md');
  const binary = 'Binary files a/shot.png and b/shot.png differ';
  assert.strictEqual(side(binary, 'a/shot.png'), 'shot.png');
  assert.strictEqual(side(binary, 'b/shot.png'), 'shot.png');
});

test('-R swaps the sides, so either letter fits either slot', () => {
  assert.strictEqual(side('--- b/notes.md', 'b/notes.md'), 'notes.md');
  assert.strictEqual(side('+++ a/notes.md', 'a/notes.md'), 'notes.md');
});

test('a header behind a CLI gutter still counts', () => {
  assert.strictEqual(side('  └ diff --git a/x/plan.md b/x/plan.md', 'b/x/plan.md'), 'x/plan.md');
  assert.strictEqual(side('    +++ b/x/plan.md', 'b/x/plan.md'), 'x/plan.md');
});

test('only the line holding the token is read', () => {
  const text = 'diff --git a/one.md b/one.md\nsee a/two.md';
  assert.strictEqual(side(text, 'a/two.md'), null);
  assert.strictEqual(side(text, 'b/one.md'), 'one.md');
});

test('an a/ folder outside a header is a real folder', () => {
  assert.strictEqual(side('see a/plan.md', 'a/plan.md'), null);
  assert.strictEqual(side('x--- a/plan.md', 'a/plan.md'), null);
  assert.strictEqual(side('rename from a/plan.md', 'a/plan.md'), null);
});

test('a path without a side prefix is left alone', () => {
  assert.strictEqual(side('--- docs/setup.md', 'docs/setup.md'), null);
  assert.strictEqual(side('diff --git c/plan.md w/plan.md', 'c/plan.md'), null);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
