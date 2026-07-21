const {
  buildTerminalCommentBatchMessage,
  buildTerminalCommentMessage,
  normalizeOutputLine,
} = require('../src/terminal-annotations');

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
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

console.log('\n--- terminal annotations ---\n');

test('normalizes output lines by trimming trailing whitespace only', () => {
  assertEqual(normalizeOutputLine('  keep leading  \t  '), '  keep leading');
});

test('buildTerminalCommentMessage formats a compact line comment', () => {
  const message = buildTerminalCommentMessage({
    kind: 'line',
    targetLine: { row: 12, text: 'FAIL parser.test.js' },
    comment: 'This failure is unexpected.',
  });

  assertEqual(message, [
    'My comment on terminal output:',
    '...',
    'FAIL parser.test.js',
    '[Comment]',
    'This failure is unexpected.',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentMessage trims leading margin for a single line comment', () => {
  const message = buildTerminalCommentMessage({
    kind: 'line',
    targetLine: { row: 12, text: '  What it does:' },
    comment: 'Test',
  });

  assertEqual(message, [
    'My comment on terminal output:',
    '...',
    'What it does:',
    '[Comment]',
    'Test',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentBatchMessage keeps adjacent line comments in one stream', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'line',
      targetLine: { row: 10, text: 'line 10' },
      comment: 'comment on 10',
      createdAt: 1,
    },
    {
      kind: 'line',
      targetLine: { row: 11, text: 'line 11' },
      comment: 'comment on 11',
      createdAt: 2,
    },
  ]);

  assertEqual(message, [
    'My comments on terminal output:',
    '...',
    'line 10',
    '[Comment on line above]',
    'comment on 10',
    '[/Comment]',
    'line 11',
    '[Comment on line above]',
    'comment on 11',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentBatchMessage trims common leading output margin', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'line',
      targetLine: { row: 10, text: '  parent line' },
      comment: 'comment on parent',
      createdAt: 1,
    },
    {
      kind: 'line',
      targetLine: { row: 11, text: '    child line' },
      comment: 'comment on child',
      createdAt: 2,
    },
  ]);

  assertEqual(message, [
    'My comments on terminal output:',
    '...',
    'parent line',
    '[Comment on line above]',
    'comment on parent',
    '[/Comment]',
    '  child line',
    '[Comment on line above]',
    'comment on child',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentBatchMessage preserves unshared indentation', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'line',
      targetLine: { row: 10, text: 'root line' },
      comment: 'comment on root',
      createdAt: 1,
    },
    {
      kind: 'line',
      targetLine: { row: 11, text: '  indented detail' },
      comment: 'comment on detail',
      createdAt: 2,
    },
  ]);

  assert(message.includes('root line\n[Comment on line above]'));
  assert(message.includes('[/Comment]\n  indented detail\n[Comment on line above]'));
});

test('buildTerminalCommentMessage marks a single selection without numbering', () => {
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, text: 'const value = parse(token, fallbackToken)' },
    ],
    selection: {
      start: { row: 5, column: 20 },
      end: { row: 5, column: 25 },
    },
    selectedText: 'token',
    comment: 'I mean this exact token.',
  });

  assertEqual(message, [
    'My selection and comment on terminal output:',
    '...',
    'const value = parse([selected]token[/selected], fallbackToken)',
    '[Comment on selection]',
    'I mean this exact token.',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentMessage adjusts selection markers after common margin trim', () => {
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, text: '    parse(token)' },
    ],
    selection: {
      start: { row: 5, column: 10 },
      end: { row: 5, column: 15 },
    },
    selectedText: 'token',
    comment: 'This exact token is still selected.',
  });

  assertEqual(message, [
    'My selection and comment on terminal output:',
    '...',
    'parse([selected]token[/selected])',
    '[Comment on selection]',
    'This exact token is still selected.',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentMessage crops a long selection line without inline ellipses', () => {
  const prefix = 'alpha beta gamma delta epsilon zeta eta theta iota kappa '.repeat(4);
  const suffix = ' lambda mu nu xi omicron pi rho sigma tau upsilon'.repeat(4);
  const text = `${prefix}targetToken${suffix}`;
  const start = prefix.length;
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [{ row: 5, text }],
    selection: {
      start: { row: 5, column: start },
      end: { row: 5, column: start + 'targetToken'.length },
    },
    selectedText: 'targetToken',
    comment: 'This exact token is the issue.',
  });

  const outputLine = message.split('\n')[2];
  assert(outputLine.includes('[selected]targetToken[/selected]'), 'cropped line should preserve the selected token');
  assert(!outputLine.includes('...'), 'cropped selection snippets should not use inline ellipses');
  assert(outputLine.length < text.length, 'long logical line should be cropped around the selection');
});

test('buildTerminalCommentMessage keeps context and markers for a short multi-line selection', () => {
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, text: 'first logical line with selected text' },
      { row: 6, text: 'continued selected text on next logical line' },
    ],
    selection: {
      start: { row: 5, column: 24 },
      end: { row: 6, column: 23 },
    },
    selectedText: 'selected text\ncontinued selected text',
    comment: 'This selection spans two logical lines.',
  });

  assertEqual(message, [
    'My selection and comment on terminal output:',
    '...',
    'first logical line with [selected]selected text',
    'continued selected text[/selected] on next logical line',
    '[Comment on selection]',
    'This selection spans two logical lines.',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentMessage closes a short selection ending at the next row boundary', () => {
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, text: 'prefix selected through end' },
    ],
    selection: {
      start: { row: 5, column: 7 },
      end: { row: 6, column: 0 },
    },
    selectedText: 'selected through end',
    comment: 'The boundary should stay attached to row five.',
  });

  assertEqual(message, [
    'My selection and comment on terminal output:',
    '...',
    'prefix [selected]selected through end[/selected]',
    '[Comment on selection]',
    'The boundary should stay attached to row five.',
    '[/Comment]',
    '...',
  ].join('\n'));
});

test('buildTerminalCommentMessage formats long same-line selection as a passage', () => {
  const prefix = 'outside context before ';
  const selected = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.repeat(3);
  const suffix = ' outside context after';
  const text = `${prefix}${selected}${suffix}`;
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [{ row: 5, text }],
    selection: {
      start: { row: 5, column: prefix.length },
      end: { row: 5, column: prefix.length + selected.length },
    },
    selectedText: selected,
    comment: 'This selected passage is the point.',
  });

  assert(!message.includes(prefix.trim()), 'long passage should omit preceding context');
  assert(!message.includes(suffix.trim()), 'long passage should omit following context');
  assert(message.includes(`[selected]${selected}[/selected]`), 'long passage should mark the selected text explicitly');
  assert(message.includes('[Comment on selection]\nThis selected passage is the point.'), 'long passage should use the selection comment label');
});

test('buildTerminalCommentMessage keeps a genuinely long multi-line selection as a passage', () => {
  const first = 'alpha '.repeat(25).trim();
  const second = 'beta '.repeat(30).trim();
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, text: `before ${first}` },
      { row: 6, text: `${second} after` },
    ],
    selection: {
      start: { row: 5, column: 'before '.length },
      end: { row: 6, column: second.length },
    },
    selectedText: `${first}\n${second}`,
    comment: 'This genuinely broad passage should stay compact.',
  });

  assert(!message.includes('before'), 'broad passage should omit preceding context');
  assert(!message.includes('after'), 'broad passage should omit following context');
  assert(message.includes(`[selected]${first}\n${second}[/selected]`), 'broad passage should mark its selected lines explicitly');
  assert(message.includes('[Comment on selection]\nThis genuinely broad passage should stay compact.'));
});

test('buildTerminalCommentMessage attaches passage comments to wrapped logical rows', () => {
  const logicalLine = 'wrapped logical line selected across physical rows';
  const message = buildTerminalCommentMessage({
    kind: 'selection',
    contextLines: [
      { row: 5, endRow: 7, text: logicalLine },
    ],
    selection: {
      start: { row: 5, column: 0 },
      end: { row: 5, column: logicalLine.length },
    },
    selectedText: logicalLine.repeat(6),
    comment: 'Comment should still be emitted.',
  });

  assert(message.includes(`[selected]${logicalLine}[/selected]\n[Comment on selection]\nComment should still be emitted.`));
});

test('buildTerminalCommentBatchMessage inserts ellipses for omitted gaps', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'line',
      targetLine: { row: 1, text: 'first relevant line' },
      comment: 'first comment',
    },
    {
      kind: 'line',
      targetLine: { row: 10, text: 'second relevant line' },
      comment: 'second comment',
    },
  ]);

  assert(message.includes('[/Comment]\n...\nsecond relevant line'), 'gap should be represented with ellipsis');
  assertEqual((message.match(/^\.\.\.$/gm) || []).length, 3, 'leading, middle, and trailing omissions should be shown');
});

test('buildTerminalCommentBatchMessage treats wrapped logical line endRow as contiguous output', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'line',
      targetLine: { row: 5, endRow: 7, text: 'first logical line that wrapped in the terminal viewport' },
      comment: 'comment on wrapped logical line',
      createdAt: 1,
    },
    {
      kind: 'line',
      targetLine: { row: 8, text: 'next logical line' },
      comment: 'comment on next logical line',
      createdAt: 2,
    },
  ]);

  assert(
    message.includes('[/Comment]\nnext logical line'),
    'wrapped physical rows should not create an omitted-output ellipsis',
  );
});

test('buildTerminalCommentBatchMessage handles two close selections on the same line', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'selection',
      contextLines: [{ row: 7, text: 'parse(token, fallbackToken, token)' }],
      selection: {
        start: { row: 7, column: 6 },
        end: { row: 7, column: 11 },
      },
      selectedText: 'token',
      comment: 'first selected token',
      createdAt: 1,
    },
    {
      kind: 'selection',
      contextLines: [{ row: 7, text: 'parse(token, fallbackToken, token)' }],
      selection: {
        start: { row: 7, column: 28 },
        end: { row: 7, column: 33 },
      },
      selectedText: 'token',
      comment: 'second selected token',
      createdAt: 2,
    },
  ]);

  assert(message.startsWith('My selections and comments on terminal output:\n'));
  assert(message.includes('parse([selected 1]token[/selected 1], fallbackToken, [selected 2]token[/selected 2])'));
  assert(message.includes('[Comment on selection 1]\nfirst selected token\n[/Comment]'));
  assert(message.includes('[Comment on selection 2]\nsecond selected token\n[/Comment]'));
  assertEqual((message.match(/^parse\(/gm) || []).length, 1, 'shared line should be emitted once');
});

test('buildTerminalCommentBatchMessage numbers precise and broad selections together', () => {
  const broad = 'b'.repeat(241);
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'selection',
      contextLines: [{ row: 7, text: `before ${broad} after` }],
      selection: {
        start: { row: 7, column: 'before '.length },
        end: { row: 7, column: 'before '.length + broad.length },
      },
      selectedText: broad,
      comment: 'broad selection',
      createdAt: 1,
    },
    {
      kind: 'selection',
      contextLines: [{ row: 10, text: 'parse(token)' }],
      selection: {
        start: { row: 10, column: 6 },
        end: { row: 10, column: 11 },
      },
      selectedText: 'token',
      comment: 'precise selection',
      createdAt: 2,
    },
  ]);

  assert(message.includes(`[selected 1]${broad}[/selected 1]`));
  assert(message.includes('[Comment on selection 1]\nbroad selection\n[/Comment]'));
  assert(message.includes('parse([selected 2]token[/selected 2])'));
  assert(message.includes('[Comment on selection 2]\nprecise selection\n[/Comment]'));
});

test('buildTerminalCommentBatchMessage mixes line and selection comments in stream order', () => {
  const message = buildTerminalCommentBatchMessage([
    {
      kind: 'selection',
      contextLines: [
        { row: 20, text: 'return parse(token)' },
        { row: 21, text: 'done' },
      ],
      selection: {
        start: { row: 20, column: 13 },
        end: { row: 20, column: 18 },
      },
      selectedText: 'token',
      comment: 'selected token',
      createdAt: 2,
    },
    {
      kind: 'line',
      targetLine: { row: 10, text: 'earlier failure' },
      comment: 'line comment',
      createdAt: 1,
    },
  ]);

  assert(message.startsWith('My selection and comments on terminal output:\n'));
  assert(message.indexOf('earlier failure') < message.indexOf('return parse('), 'comments should be ordered by terminal position');
  assert(message.includes('earlier failure\n[Comment on line above]\nline comment'));
  assert(message.includes('return parse([selected]token[/selected])\n[Comment on selection]\nselected token'));
});

runTests();
