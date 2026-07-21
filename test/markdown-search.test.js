const { findMarkdownSearchRanges } = require('../src/markdown-viewer');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL ${name}`);
      console.log(`  ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log('\n--- markdown search ---\n');

test('findMarkdownSearchRanges finds case-insensitive rendered text matches', () => {
  assertEqual(
    findMarkdownSearchRanges('Rendered Markdown rendered text', 'rendered'),
    [
      { start: 0, end: 8 },
      { start: 18, end: 26 },
    ],
  );
});

test('findMarkdownSearchRanges skips overlapping matches for stable DOM marks', () => {
  assertEqual(
    findMarkdownSearchRanges('aaaa', 'aa'),
    [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
  );
});

test('findMarkdownSearchRanges returns no ranges for an empty query', () => {
  assertEqual(findMarkdownSearchRanges('anything', ''), []);
});

runTests();
