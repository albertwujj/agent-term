// Run with: node test/diff-rows.test.js
const assert = require('assert');
const {
  parseDiffLineText,
  diffLineContinuedAt,
  diffBodyTop,
  diffMinusTarget,
} = require('../src/diff-rows');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

// A buffer of rows as xterm hands them over. A row given as { text, wrapped }
// is the soft-wrapped tail of the row above it, the way a reflow leaves it.
function bufferOf(rows) {
  const lines = rows.map((row) => (typeof row === 'string' ? { text: row, wrapped: false } : row));
  return {
    length: lines.length,
    getLine(i) {
      const line = lines[i];
      return line && { isWrapped: line.wrapped, translateToString: () => line.text };
    },
  };
}

const rowOf = (rows, text) => {
  const index = rows.indexOf(text);
  if (index < 0) throw new Error(`fixture has no row ${JSON.stringify(text)}`);
  return index;
};

// docs/review.md as Claude Code printed its Update, at 114 columns of text.
// Each line's file context used to be the nearest path-looking text above it:
// 5 found the header, 6 and the deletion of 8 found `/strong` in line 5's
// `</strong>` (an absolute path, so the IDE), and the addition of 8 and line 10
// found `comment.md` in the deletion's wrapped rows. The wrapped rows, with no
// number of their own, were no target at all.
const REVIEW = [
  '● Update(docs/review.md)',
  '  ⎿  Added 1 line, removed 1 line',
  '       5  <br><strong>Code: what you propose and what the agent changes</strong>',
  '       6  </p>',
  '       7',
  '       8 -When the agent finishes, it prepares your review: it hands you the parts that need your judgment, ordered and expl',
  "         -ained with trade-offs flagged, and leaves out what doesn't need it: the routine changes (renames, imports, boilerp",
  '         -late) and what you already settled during the session. [Comment inline](comment.md), on the code *and* on its reas',
  '         -oning; it edits and replies in the thread, with the latest version shown in real time.',
  '       8 +When the agent finishes, it prepares your review: it hands you the parts that need your judgment, ordered and expl',
  "         +ained, with each trade-off it chose flagged as a decision you can confirm in one click, and leaves out what doesn'",
  '         +t need it: the routine changes (renames, imports, boilerplate) and what you already settled during the session. [C',
  '         +omment inline](comment.md), on the code *and* on its reasoning; it edits and replies in the thread, with the lates',
  '         +t version shown in real time.',
  '       9',
  '      10  You can ask the agent to expand any part, or include all changes in the review, with the parts that most need your',
  '           judgment first.',
  '',
];
const review = bufferOf(REVIEW);
const REVIEW_TOP = rowOf(REVIEW, '  ⎿  Added 1 line, removed 1 line');

check('every numbered row of a diff reaches the header above its body', () => {
  for (const [row, text] of REVIEW.entries()) {
    if (!parseDiffLineText(text)) continue;
    assert.strictEqual(diffBodyTop(review, row), REVIEW_TOP, text);
  }
});

check('a wrapped row of a deletion is a piece of its numbered line', () => {
  for (let row = 6; row <= 8; row++) {
    const continued = diffLineContinuedAt(review, row);
    assert.ok(continued, REVIEW[row]);
    assert.strictEqual(continued.head.row, 5);
    assert.strictEqual(continued.head.lineNum, 8);
    assert.strictEqual(continued.head.marker, '-');
  }
});

check('a wrapped row of an addition is a piece of its numbered line', () => {
  for (let row = 10; row <= 13; row++) {
    const continued = diffLineContinuedAt(review, row);
    assert.ok(continued, REVIEW[row]);
    assert.strictEqual(continued.head.row, 9);
    assert.strictEqual(continued.head.marker, '+');
  }
});

check('a context line wraps without a marker and is still a piece of its line', () => {
  const continued = diffLineContinuedAt(review, rowOf(REVIEW, '           judgment first.'));
  assert.strictEqual(continued.head.lineNum, 10);
  assert.strictEqual(continued.head.marker, undefined);
});

check('a piece covers its row, so the whole row is the target', () => {
  const row = rowOf(REVIEW, '         +t version shown in real time.');
  const { start, end } = diffLineContinuedAt(review, row);
  assert.deepStrictEqual([start, end], [0, REVIEW[row].length]);
});

check('numbered rows, empty lines and the header are no piece of anything', () => {
  for (const text of [
    '       6  </p>',
    '       7',
    '       9',
    '      10  You can ask the agent to expand any part, or include all changes in the review, with the parts that most need your',
    '  ⎿  Added 1 line, removed 1 line',
    '● Update(docs/review.md)',
    '',
  ]) {
    assert.strictEqual(diffLineContinuedAt(review, rowOf(REVIEW, text)), null, text);
  }
});

check('a deletion lands on the line that took its place', () => {
  assert.deepStrictEqual(diffMinusTarget(review, 5), {
    lineNum: 8,
    codeText: 'When the agent finishes, it prepares your review: it hands you the parts that need your judgment, ordered and expl',
  });
});

// Captured from Claude Code 2.1.296 at 100 columns: one replace_all Edit, two
// hunks. Each hunk sizes its own gutter (the marker is in column 8 in the
// first, 9 in the second) and `...` separates them.
const NOTES = [
  '⏺ Update(notes.md)',
  '  ⎿  Added 2 lines, removed 2 lines',
  '      1  Line 1 filler text.',
  '      2  Line 2 filler text.',
  '      3 -The alpha release ships when the review loop hands you the parts that need your judg',
  '        -ment, ordered and explained, with every trade-off flagged; see [Comment inline](comm',
  '        -ent.md) for the thread.                                                             ',
  '      3 +The ALPHA release ships when the review loop hands you the parts that need your judg',
  '        +ment, ordered and explained, with every trade-off flagged; see [Comment inline](comm',
  '        +ent.md) for the thread.                                                             ',
  '      4  Line 4 filler text.',
  '      5  Line 5 filler text.',
  '      6  Line 6 filler text.',
  '     ...',
  '      27  Line 27 filler text.',
  '      28  Line 28 filler text.',
  '      29  Line 29 filler text.',
  '      30 -Closing note: alpha again, far below, so the edit shows a second hunk.             ',
  '      30 +Closing note: ALPHA again, far below, so the edit shows a second hunk.             ',
  '      31  Line 31 filler text.',
  '',
  '⏺ I replaced every "alpha" with "ALPHA" in notes.md using one Edit call with replace_all on.',
];
const notes = bufferOf(NOTES);
const NOTES_TOP = rowOf(NOTES, '  ⎿  Added 2 lines, removed 2 lines');

check('a later hunk reaches the header across the separator and an earlier, narrower gutter', () => {
  for (const [row, text] of NOTES.entries()) {
    if (!parseDiffLineText(text)) continue;
    assert.strictEqual(diffBodyTop(notes, row), NOTES_TOP, text);
  }
});

check('wrapped rows follow the gutter of their own hunk', () => {
  assert.strictEqual(diffLineContinuedAt(notes, 5).head.row, 4);
  assert.strictEqual(diffLineContinuedAt(notes, 6).head.row, 4);
  assert.strictEqual(diffLineContinuedAt(notes, 8).head.row, 7);
  assert.strictEqual(diffLineContinuedAt(notes, 9).head.marker, '+');
});

check('the separator and the prose after the diff are no piece of a line', () => {
  assert.strictEqual(diffLineContinuedAt(notes, rowOf(NOTES, '     ...')), null);
  assert.strictEqual(diffLineContinuedAt(notes, NOTES.length - 1), null);
});

check('a row repeating the other marker belongs to no line', () => {
  const buffer = bufferOf([
    '  ⎿  Added 1 line, removed 1 line',
    '      3 -The alpha release ships',
    '        +ment, ordered and explained',
  ]);
  assert.strictEqual(diffLineContinuedAt(buffer, 2), null);
});

check('indented prose after a blank row is not a piece of the line above the blank', () => {
  const buffer = bufferOf([
    '      31  Line 31 filler text.',
    '',
    '          indented prose that happens to clear the gutter',
  ]);
  assert.strictEqual(diffLineContinuedAt(buffer, 2), null);
});

check('a body that runs off the top of the buffer names no header', () => {
  const buffer = bufferOf(NOTES.slice(2));
  assert.strictEqual(diffBodyTop(buffer, rowOf(NOTES.slice(2), '      30 +Closing note: ALPHA again, far below, so the edit shows a second hunk.             ')), null);
});

check('rows the terminal soft-wrapped after a resize still read as one line', () => {
  const buffer = bufferOf([
    '  ⎿  Added 1 line, removed 1 line',
    '      3 -The alpha release ships when the review loop hands you',
    { text: ' the parts that need your judg', wrapped: true },
    '        -ment, ordered and explained, with every trade-off flagged; see',
    { text: ' [Comment inline](comm', wrapped: true },
    '        -ent.md) for the thread.',
  ]);
  assert.strictEqual(diffLineContinuedAt(buffer, 3).head.row, 1);
  assert.strictEqual(diffLineContinuedAt(buffer, 5).head.row, 1);
  assert.strictEqual(diffBodyTop(buffer, 1), 0);
});

check('a boxed diff wraps inside its borders', () => {
  const buffer = bufferOf([
    '│ docs/review.md                     │',
    '│   8 -When the agent finishes, it   │',
    '│     -prepares your review          │',
    '│   8 +When the agent finishes, it   │',
  ]);
  const continued = diffLineContinuedAt(buffer, 2);
  assert.strictEqual(continued.head.row, 1);
  assert.deepStrictEqual([continued.start, continued.end], [2, '│     -prepares your review'.length]);
  assert.strictEqual(diffBodyTop(buffer, 3), 0);
});

console.log(`\n${passed} passed`);
