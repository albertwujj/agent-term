const { smartCopyText, stripLine } = require('../src/smart-copy');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n    Expected: ${JSON.stringify(expected)}\n    Actual:   ${JSON.stringify(actual)}`);
  }
}

test('a wrapped claude paragraph becomes one line, gutter gone', () => {
  const raw = [
    '⏺ The function reads the config once at startup and caches it, so a change',
    '  on disk needs a restart before it shows up.',
  ].join('\n');
  assertEqual(
    smartCopyText(raw),
    'The function reads the config once at startup and caches it, so a change on disk needs a restart before it shows up.',
  );
});

test('punctuation, paths and file:line references survive', () => {
  const raw = [
    "⏺ Don't touch src/foo.js:42 (it's the \"hot\" path); see e.g. `bar()` and",
    '  the README.',
  ].join('\n');
  assertEqual(
    smartCopyText(raw),
    "Don't touch src/foo.js:42 (it's the \"hot\" path); see e.g. `bar()` and the README.",
  );
});

test('a blank line stays a paragraph break', () => {
  const raw = [
    '⏺ First paragraph that',
    '  wraps.',
    '',
    '⏺ Second paragraph.',
  ].join('\n');
  assertEqual(smartCopyText(raw), 'First paragraph that wraps.\n\nSecond paragraph.');
});

test('each gutter-marked line starts its own line without a blank between', () => {
  const raw = [
    '⏺ Read(src/foo.js)',
    '  ⎿  Read 40 lines',
  ].join('\n');
  assertEqual(smartCopyText(raw), 'Read(src/foo.js)\nRead 40 lines');
});

test('codex bullets mark paragraphs; › marks the prompt', () => {
  const raw = [
    '› make it shorter',
    '',
    '• Trimmed the intro to two',
    '  sentences.',
    '• Kept the example.',
  ].join('\n');
  assertEqual(smartCopyText(raw), 'make it shorter\n\nTrimmed the intro to two sentences.\nKept the example.');
});

test('box borders strip without breaking the line; edges vanish', () => {
  const raw = [
    '╭──────────────────────────────╮',
    '│ > fix the flaky test in ci   │',
    '│   and explain why            │',
    '╰──────────────────────────────╯',
  ].join('\n');
  assertEqual(smartCopyText(raw), 'fix the flaky test in ci and explain why');
});

test('a rule between paragraphs is a separator', () => {
  const raw = ['one', '────────', 'two'].join('\n');
  assertEqual(smartCopyText(raw), 'one\n\ntwo');
});

test('list items keep their markers, one per line, wrapped items rejoin', () => {
  const raw = [
    '⏺ Two options:',
    '  - keep the cache and add a',
    '    file watcher',
    '  - drop the cache',
    '  1. first',
    '  2) second',
  ].join('\n');
  assertEqual(
    smartCopyText(raw),
    'Two options:\n- keep the cache and add a file watcher\n- drop the cache\n1. first\n2) second',
  );
});

test('a trailing markdown table pipe stays; a leading ASCII pipe is a border', () => {
  assertEqual(smartCopyText('| a | b |'), 'a | b |');
});

test('interior whitespace runs and tabs collapse to one space', () => {
  assertEqual(smartCopyText('name:\t\tvalue    here'), 'name: value here');
});

test('plain lines without gutter join as one paragraph', () => {
  assertEqual(smartCopyText('one two\nthree four\nfive'), 'one two three four five');
});

test('a line that is only whitespace after a gutter mark is a separator', () => {
  assertEqual(smartCopyText('⏺ a\n⏺\n⏺ b'), 'a\n\nb');
});

test('CRLF and trailing blanks are tolerated; empty in, empty out', () => {
  assertEqual(smartCopyText('a\r\nb\r\n\r\n'), 'a b');
  assertEqual(smartCopyText(''), '');
  assertEqual(smartCopyText(null), '');
});

test('a mid-line > is not a gutter', () => {
  assertEqual(smartCopyText('a -> b'), 'a -> b');
});

test('stripLine reports a new line for marks and list items, not borders', () => {
  assertEqual(stripLine('│ inside').startsLine, false);
  assertEqual(stripLine('│ inside').text, 'inside');
  assertEqual(stripLine('⏺ start').startsLine, true);
  assertEqual(stripLine('  - item').startsLine, true);
  assertEqual(stripLine('  - item').text, '- item');
  assertEqual(stripLine('2024 was busy').startsLine, false);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}`);
      console.log(`  ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
