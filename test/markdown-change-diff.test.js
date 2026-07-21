const {
  diffArrays,
  findDeletionAnchorRanges,
  findInsertedTextRanges,
  getLineDiffOpcodes,
  hasNewWordSignal,
} = require('../src/markdown-change-diff');

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

function rangeTexts(text, ranges) {
  return ranges.map((range) => text.slice(range.start, range.end));
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

console.log('\n--- markdown change diff ---\n');

test('diffArrays reports a single token replacement', () => {
  assertEqual(
    diffArrays(['a', 'b', 'c'], ['a', 'x', 'c']),
    [
      { tag: 'equal', i1: 0, i2: 1, j1: 0, j2: 1 },
      { tag: 'replace', i1: 1, i2: 2, j1: 1, j2: 2 },
      { tag: 'equal', i1: 2, i2: 3, j1: 2, j2: 3 },
    ],
  );
});

test('getLineDiffOpcodes preserves separated edits', () => {
  assertEqual(
    getLineDiffOpcodes('one\ntwo\nthree\nfour', 'one\nTWO\nthree\nFOUR'),
    [
      { tag: 'equal', i1: 0, i2: 1, j1: 0, j2: 1 },
      { tag: 'replace', i1: 1, i2: 2, j1: 1, j2: 2 },
      { tag: 'equal', i1: 2, i2: 3, j1: 2, j2: 3 },
      { tag: 'replace', i1: 3, i2: 4, j1: 3, j2: 4 },
    ],
  );
});

test('findInsertedTextRanges highlights replacement text in the current document', () => {
  assertEqual(
    findInsertedTextRanges('hello terminal world', 'hello viewer world'),
    [{ start: 6, end: 12 }],
  );
});

test('findInsertedTextRanges highlights multiple inserted runs', () => {
  assertEqual(
    findInsertedTextRanges('one two three four', 'one two and three five four'),
    [
      { start: 8, end: 11 },
      { start: 18, end: 22 },
    ],
  );
});

test('findInsertedTextRanges merges adjacent changed words into one run', () => {
  // "Change one or varied" -> "Edit several different"; the trailing "words" is unchanged.
  // The three changed words highlight as a single mark (spaces included), not a stripe per word.
  assertEqual(
    findInsertedTextRanges('Change one or varied words', 'Edit several different words'),
    [{ start: 0, end: 22 }],
  );
});

test('findInsertedTextRanges ignores whitespace-only insertions', () => {
  assertEqual(findInsertedTextRanges('one two', 'one  two'), []);
});

test('findInsertedTextRanges highlights all visible text for a new block', () => {
  assertEqual(findInsertedTextRanges('', 'new block'), [{ start: 0, end: 9 }]);
});

test('findInsertedTextRanges treats deletion with punctuation handoff as no exact text insertion', () => {
  assertEqual(
    findInsertedTextRanges('List item one can be edited.', 'List item one can be.'),
    [],
  );
});

test('hasNewWordSignal requires a genuinely new word for replacement highlights', () => {
  assertEqual(hasNewWordSignal('be edited.', 'be.'), false);
  assertEqual(hasNewWordSignal('removed', 'revised'), true);
});

test('findDeletionAnchorRanges highlights one surviving word on each side', () => {
  const oldText = 'The second paragraph is useful for testing deletions. The viewer should continue.';
  const newText = 'The second paragraph is useful for testing. The viewer should continue.';
  assertEqual(rangeTexts(newText, findDeletionAnchorRanges(oldText, newText)), ['testing.', 'The']);
});

test('findDeletionAnchorRanges uses one available edge word, not two', () => {
  assertEqual(rangeTexts('foo', findDeletionAnchorRanges('foo bar', 'foo')), ['foo']);
  assertEqual(rangeTexts('bar', findDeletionAnchorRanges('foo bar', 'bar')), ['bar']);
});

test('findDeletionAnchorRanges treats punctuation handoff as a local deletion anchor', () => {
  const newText = 'List item one can be.';
  assertEqual(
    rangeTexts(newText, findDeletionAnchorRanges('List item one can be edited.', newText)),
    ['be.'],
  );
});

test('findDeletionAnchorRanges includes attached punctuation on edge deletions', () => {
  const newText = 'different areas.';
  assertEqual(
    rangeTexts(newText, findDeletionAnchorRanges('different areas of the document.', newText)),
    ['areas.'],
  );
});

test('findDeletionAnchorRanges ignores punctuation-only replacements', () => {
  assertEqual(findDeletionAnchorRanges('hello, world', 'hello. world'), []);
});

runTests();
