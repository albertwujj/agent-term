// Copy a terminal selection as message text (Cmd/Ctrl+Shift+C).
//
// Agent output is laid out for the terminal: the CLI hard-wraps prose at the
// column width, prefixes lines with its gutter (⏺ ⎿ › • and box borders), and
// pads with spaces. Plain copy keeps all of that, so a pasted passage lands in
// a chat as a paragraph chopped into 80-column lines with glyphs down the left
// edge. This copy strips only what is certainly layout and leaves the words
// whole: a stray glyph left behind is one delete, a missing apostrophe in
// every sentence is a rewrite. Punctuation, paths and file:line references
// stay; the viewer's ⧉ plain copy uses the same shape (docs/copy.md), so
// "copy for a message" means one thing across the app.
//
// Lines. xterm already rejoins the rows the terminal wrapped; the splits left
// in a selection are the CLI's own. Consecutive text lines join into one
// paragraph, a blank line stays a blank line, and a line that starts with a
// gutter mark (⏺ • › > ⎿ ...) or a list marker (- * 1.) starts its own line:
// that is how each CLI begins a message, a tool result or an item. Box
// borders (│ and the corners) are stripped without breaking the line, since
// every row inside a box carries one.

// Box drawing. Stripped at either edge of a line; never a line break on its
// own. `|` covers terminals that draw borders in ASCII, at the start only: a
// trailing `|` is a markdown table row, which stays as typed.
const BORDER = '\\u2500-\\u257F';
// Gutter marks. Arrows, technical symbols (⏺ ⎿), block elements and shapes
// (● ▪ ◦), misc symbols and dingbats (✻ ✦ ✓ ❯), braille spinner frames, the
// bullet and › of codex. Stripped at either edge; at the start, the line is a
// new one.
const MARK = '\\u2190-\\u21FF\\u2300-\\u23FF\\u2580-\\u25FF\\u2600-\\u27BF\\u2800-\\u28FF\\u2B00-\\u2BFF\\u2022\\u203A';

const LEADING_BORDER = new RegExp(`^[${BORDER}|]+\\s*`, 'u');
const LEADING_MARK = new RegExp(`^[${MARK}>]+\\s*`, 'u');
const TRAILING_GLYPHS = new RegExp(`(?:\\s*[${BORDER}${MARK}])+$`, 'u');
// A list item, its marker kept: dash, star or plus, or a number with a dot or
// a paren, followed by a space and text.
const LIST_ITEM = /^(?:[-*+]|\d+[.)]) \S/;

// One source line → its text with the gutter gone, and whether it begins a
// line of its own in the output.
function stripLine(line) {
  let text = String(line).replace(/\s+/g, ' ').trim();
  let startsLine = false;
  for (;;) {
    const border = LEADING_BORDER.exec(text);
    if (border) { text = text.slice(border[0].length); continue; }
    const mark = LEADING_MARK.exec(text);
    if (mark) { text = text.slice(mark[0].length); startsLine = true; continue; }
    break;
  }
  text = text.replace(TRAILING_GLYPHS, '').trim();
  if (LIST_ITEM.test(text)) startsLine = true;
  return { text, startsLine };
}

function smartCopyText(raw) {
  const lines = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  // Whether the last output line is prose a continuation row may join onto.
  let open = false;
  for (const line of lines) {
    const { text, startsLine } = stripLine(line);
    if (!text) {
      // Blank, or a rule / box edge with nothing else on it: a separator.
      if (out.length && out[out.length - 1] !== '') out.push('');
      open = false;
      continue;
    }
    if (startsLine || !open) out.push(text);
    else out[out.length - 1] += ' ' + text;
    open = true;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { smartCopyText, stripLine };
