const { smartCopyText, stripLine, displayWidth } = require('../src/smart-copy');

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

test('whitespace inside a line is untouched', () => {
  assertEqual(smartCopyText('name:\t\tvalue    here'), 'name:\t\tvalue    here');
  assertEqual(smartCopyText('│ a  │ b │'), 'a  │ b');
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

// With the terminal width known, a break is a wrap only when the line reached
// the wrap column and the next word would not have fit.
const FULL = '⏺ selected prose that runs all the way out to the right edge of the row'; // 71 columns

test('short lines keep their breaks when nothing reached the right edge', () => {
  assertEqual(
    smartCopyText('  const x = 1;\n  const longerName = compute(x);\n  return x;', { cols: 80 }),
    'const x = 1;\nconst longerName = compute(x);\nreturn x;',
  );
  assertEqual(smartCopyText('Done.\nNext: run tests.', { cols: 80 }), 'Done.\nNext: run tests.');
});

test('a full line joins its continuation; a line ending short of the edge keeps its break', () => {
  assertEqual(FULL.length, 71);
  assertEqual(
    smartCopyText(`${FULL}\n  wraps here.\n  Another line.`, { cols: 80 }),
    'selected prose that runs all the way out to the right edge of the row wraps here.\nAnother line.',
  );
});

test('a continuation whose first word would have fit is a real line', () => {
  // 71 + 1 + 2 = 74 ≤ 76: "it" would have fit on a line wrapping at 76.
  const wider = FULL + ' plus.'; // 77
  assertEqual(smartCopyText(`${wider}\n  x\n${FULL}\n  it is.`, { cols: 80 }).split('\n').length, 3);
});

test('the first line is measured from the selection start column', () => {
  const tail = 'edge of the row';
  assertEqual(smartCopyText(`${tail}\n  wraps here.`, { cols: 80, startColumn: 56 }), 'edge of the row wraps here.');
  // Without the start column the first row reads as flush, and the second
  // row's two columns are indentation relative to it.
  assertEqual(smartCopyText(`${tail}\n  wraps here.`, { cols: 80 }), 'edge of the row\n  wraps here.');
});

test('a row longer than the terminal caps the wrap column at the width', () => {
  const long = 'x'.repeat(120);
  const full = '⏺ ' + 'word '.repeat(14) + 'wordy'; // 77
  assertEqual(
    smartCopyText(`${long}\n${full}\n  tail.`, { cols: 80 }),
    `${long}\n${'word '.repeat(14)}wordy tail.`,
  );
});

test('wide characters count two columns', () => {
  assertEqual(displayWidth('ab字'), 4);
  const cjk = '⏺ ' + '字'.repeat(37); // 2 + 74
  assertEqual(smartCopyText(`${cjk}\n  继续。`, { cols: 80 }), '字'.repeat(37) + ' 继续。');
});

test('a full-width box wraps inside its borders', () => {
  const top = '╭' + '─'.repeat(38) + '╮';
  const a = '│ > fix the flaky test in ci and then'.padEnd(39) + '│';
  const b = '│   explain why'.padEnd(39) + '│';
  const bottom = '╰' + '─'.repeat(38) + '╯';
  assertEqual(smartCopyText([top, a, b, bottom].join('\n'), { cols: 40 }), 'fix the flaky test in ci and then explain why');
});

test('each blank-separated block has its own wrap column', () => {
  // The box's text edge sits two columns past the paragraph's; the paragraph
  // must still read as wrapped by its own edge, not the box's.
  const para = `${FULL}\n  and it ends.`; // edge 71
  const top = '╭' + '─'.repeat(77) + '╮';
  const a = '│ > ' + 'prompt text that reaches the edge of the box at seventy three wide'.padEnd(74) + '│'; // edge 73
  const b = '│   with a tail'.padEnd(78) + '│';
  const bottom = '╰' + '─'.repeat(77) + '╯';
  const got = smartCopyText([para, '', top, a, b, bottom].join('\n'), { cols: 80 });
  assertEqual(got.split('\n')[0], 'selected prose that runs all the way out to the right edge of the row and it ends.');
  assertEqual(got.split('\n').pop(), 'prompt text that reaches the edge of the box at seventy three wide with a tail');
});

test('code keeps its indentation relative to the block; a mark above it starts flush', () => {
  const raw = [
    '⏺ Here is the fix:',
    '    if (ready) {',
    '      start();',
    '    }',
  ].join('\n');
  assertEqual(smartCopyText(raw, { cols: 80 }), 'Here is the fix:\nif (ready) {\n  start();\n}');
});

test('nested lists keep their nesting', () => {
  const raw = [
    '  - keep the cache',
    '    - and add a watcher',
    '  - drop the cache',
  ].join('\n');
  assertEqual(smartCopyText(raw, { cols: 80 }), '- keep the cache\n  - and add a watcher\n- drop the cache');
});

test('the selection\'s first line is flush wherever it began', () => {
  assertEqual(smartCopyText('      deep first line\n  shallow second', { cols: 80 }), 'deep first line\nshallow second');
});

test('symbols in the text stay; only gutter marks go', () => {
  assertEqual(smartCopyText('⏺ ✅ Tests pass\n  → next: deploy\n  ⚠ one warning', { cols: 80 }), '✅ Tests pass\n→ next: deploy\n⚠ one warning');
  assertEqual(smartCopyText('✓ done', { cols: 80 }), '✓ done');
});

test('table rules vanish and the rows stay together, cells divided as drawn', () => {
  const raw = [
    '┌──────┬──────┐',
    '│ name │ size │',
    '├──────┼──────┤',
    '│ a.js │ 12k  │',
    '│ b.js │ 3k   │',
    '└──────┴──────┘',
  ].join('\n');
  assertEqual(smartCopyText(raw, { cols: 80 }), 'name │ size\na.js │ 12k\nb.js │ 3k');
  assertEqual(smartCopyText('| a | b |\n|---|---|\n| 1 | 2 |', { cols: 80 }), 'a | b |\n1 | 2 |');
});

test('a line filled to the last column that ends mid-path rejoins without a space', () => {
  const prefix = '⏺ see https://example.com/docs/';
  const fill = 'x'.repeat(80 - prefix.length); // filled to column 80
  assertEqual(smartCopyText(`${prefix}${fill}\n  yz/page.html for the rest`, { cols: 80 }),
    `see https://example.com/docs/${fill}yz/page.html for the rest`);
  // A full line that ends in a word, not a path, takes its space.
  const prose = '⏺ ' + 'word '.repeat(15) + 'ends'; // 81 → capped; ends in a word
  assertEqual(smartCopyText(`${prose}\n  next`, { cols: 80 }).endsWith('ends next'), true);
});

test('without a width every break is judged against the longest line', () => {
  assertEqual(smartCopyText('one two\nthree four\nfive'), 'one two three four five');
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
