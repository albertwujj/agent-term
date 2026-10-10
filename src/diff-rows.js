// The numbered diff an agent CLI prints under an edit, read off the terminal
// buffer. Claude Code's, as it lands in the buffer:
//
//   ⏺ Update(docs/review.md)
//     ⎿  Added 1 line, removed 1 line
//          5  <br><strong>Code: what you propose and what the agent changes</strong>
//          7
//          8 -When the agent finishes, it prepares your review: it hands you the parts th
//            -at need your judgment, ordered and explained; [Comment inline](comment.md)
//          8 +When the agent finishes, …
//         ...
//         30  You can ask the agent to expand any part, or include all changes in the rev
//             iew.
//
// A row is a line number, a marker column (+, - or blank) and the file's text.
// A line wider than the terminal goes on in rows with no number that repeat
// the marker, so such a row is a piece of its line, whose number is on the
// numbered row above it. Each hunk sets its own gutter width, `...` separates
// hunks, and an empty line in the file is its number alone.
//
// The body is the file's own text, so a path in it is content, never the file
// the diff edits: that is named above the body, by the header.

const { bufferLogicalLineStart, readBufferLogicalLine } = require('./viewer-history');

// A changed line allows content flush against the marker (`628 -*prose`), so the
// marker branch uses \s* after the marker; a context line has no marker, so it still
// requires \s{2,} to separate the number from content (keeps `42hello` from matching).
const STRICT_DIFF_LINE_REGEX = /^\s{2,}(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;
const INNER_DIFF_LINE_REGEX = /^\s*(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;
const STRICT_EMPTY_DIFF_LINE_REGEX = /^\s{2,}\d+\s*$/;
const INNER_EMPTY_DIFF_LINE_REGEX = /^\s*\d+\s*$/;
const HUNK_SEPARATOR_REGEX = /^\s+\.\.\.\s*$/;

// Past these, the header is out of reach and a guess would be content.
const MAX_WRAPPED_ROWS = 100;
const MAX_BODY_ROWS = 1000;

function getBorderedContentSpan(text) {
  const left = /^\s*[│┃|]\s/.exec(text);
  if (!left) return null;

  const start = left[0].length;
  let end = text.length;
  const right = /\s+[│┃|]\s*$/.exec(text.substring(start));
  if (right) end = start + right.index;

  return {
    content: text.substring(start, end),
    start,
    end,
  };
}

function parseDiffLineText(text, { allowInner = false } = {}) {
  const bordered = getBorderedContentSpan(text);
  const source = bordered ? bordered.content : text;
  const m = (bordered || allowInner ? INNER_DIFF_LINE_REGEX : STRICT_DIFF_LINE_REGEX).exec(source);
  if (!m) return null;

  return {
    lineNum: parseInt(m[1], 10),
    marker: m[2],
    codeText: m[3].trim(),
  };
}

// A row's text inside any box borders, and the span it covers in the row.
function rowContent(text) {
  const bordered = getBorderedContentSpan(text);
  return bordered
    ? { source: bordered.content, bordered: true, start: bordered.start, end: bordered.end }
    : { source: text, bordered: false, start: 0, end: text.length };
}

function logicalText(buffer, row) {
  const logical = readBufferLogicalLine(buffer, row);
  return logical ? logical.text : null;
}

function leadingSpace(text) {
  return text.length - text.trimStart().length;
}

// The numbered row at `row`, parsed, with the column its marker sits in: one
// past the space after the number.
function diffHeadAt(buffer, row) {
  const text = logicalText(buffer, row);
  const parsed = text == null ? null : parseDiffLineText(text);
  if (!parsed) return null;
  const { source, bordered } = rowContent(text);
  return { row, ...parsed, bordered, markerCol: /^\s*\d+/.exec(source)[0].length + 1 };
}

// Whether `text` goes on with a numbered row's line: it repeats a changed
// line's marker in the marker column, or starts its text past that column (a
// context line's piece, or a CLI that doesn't repeat the marker).
function continuesDiffLine(text, head) {
  const { source, bordered } = rowContent(text);
  if (bordered !== head.bordered || !source.trim()) return false;
  const lead = leadingSpace(source);
  if (lead > head.markerCol) return true;
  return lead === head.markerCol && source[lead] === head.marker;
}

// Every piece is indented at least to the marker column.
function couldContinue(text) {
  return text != null && text.trim() !== '' && /^\s/.test(rowContent(text).source);
}

// The diff line the row at `row` (a logical line start) is a wrapped piece of:
// its numbered row's parse, and the span of this row the piece covers. Null
// for a numbered row itself and for anything that is not a piece of one.
function diffLineContinuedAt(buffer, row) {
  const text = logicalText(buffer, row);
  if (!couldContinue(text) || parseDiffLineText(text)) return null;
  const pieces = [text];
  for (let r = row; r > 0 && pieces.length <= MAX_WRAPPED_ROWS;) {
    r = bufferLogicalLineStart(buffer, r - 1);
    const head = diffHeadAt(buffer, r);
    if (head) {
      if (!pieces.every((piece) => continuesDiffLine(piece, head))) return null;
      const { start, end } = rowContent(text);
      return { head, start, end };
    }
    const above = logicalText(buffer, r);
    if (!couldContinue(above)) return null;
    pieces.push(above);
  }
  return null;
}

// The row just above the body holding the numbered row at `headRow` — the
// header side, where the file the diff edits is named — or null when the body
// runs past the top of the buffer or out of reach.
function diffBodyTop(buffer, headRow) {
  const head = diffHeadAt(buffer, headRow);
  if (!head) return null;
  const empty = head.bordered ? INNER_EMPTY_DIFF_LINE_REGEX : STRICT_EMPTY_DIFF_LINE_REGEX;
  let r = headRow;
  while (r > 0 && headRow - r <= MAX_BODY_ROWS) {
    r = bufferLogicalLineStart(buffer, r - 1);
    const text = logicalText(buffer, r);
    if (text == null) return null;
    const { source, bordered } = rowContent(text);
    if (bordered === head.bordered
      && (parseDiffLineText(text) || empty.test(source) || HUNK_SEPARATOR_REGEX.test(source))) continue;
    const continued = diffLineContinuedAt(buffer, r);
    if (continued) {
      r = continued.head.row;
      continue;
    }
    return r;
  }
  return null;
}

// A deleted line has no place in the new file; it lands on the line that took
// its place: the next numbered row below it that is not itself a deletion.
function diffMinusTarget(buffer, headRow) {
  for (let r = headRow + 1; r <= Math.min(buffer.length - 1, headRow + 100); r++) {
    const line = buffer.getLine(r);
    if (!line) continue;
    const parsed = parseDiffLineText(line.translateToString());
    if (!parsed) continue;
    if (parsed.marker !== '-') {
      return { lineNum: parsed.lineNum, codeText: parsed.codeText };
    }
  }
  return null;
}

module.exports = {
  getBorderedContentSpan,
  parseDiffLineText,
  diffHeadAt,
  diffLineContinuedAt,
  diffBodyTop,
  diffMinusTarget,
};
