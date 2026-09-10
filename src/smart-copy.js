// Copy a terminal selection as message text: what the copy chord does
// (Cmd/Ctrl+C); Shift added keeps the terminal layout.
//
// Agent output is laid out for the terminal: the CLI hard-wraps prose at the
// column width, prefixes lines with its gutter (⏺ ⎿ › • and box borders), and
// pads with spaces. A verbatim copy keeps all of that, so a pasted passage
// lands in a chat as a paragraph chopped into 80-column lines with glyphs down
// the left edge. This copy strips only what is certainly layout and leaves the
// words whole: a stray glyph left behind is one delete, a missing apostrophe
// in every sentence is a rewrite. Punctuation, paths and file:line references
// stay; the viewer's ⧉ plain copy uses the same shape (docs/copy.md), so
// "copy for a message" means one thing across the app.
//
// Lines. xterm already rejoins the rows the terminal wrapped; the splits left
// in a selection are the CLI's own, and each is either a wrap or a real line
// end. The wrap column is visible in the selection: the right edge of the
// longest line in the block (the left gutter sits inside that count; the
// right gutter is what remains to the terminal width). A break is a wrap when
// the line was full, so the next line's first word would not have fit before
// that edge; a line that ends short of it ended on purpose, and keeps its
// break. When the longest line stops well short of the terminal width,
// nothing in the block wrapped, and every break is real: code, listings,
// short lines. Blocks are what blank lines separate, each measured on its
// own: a prompt box and the paragraph after it wrap a few columns apart, and
// a message's column must not be judged by its neighbour's.
// A blank line stays a blank line. A line that starts with a gutter mark
// (⏺ • › > ⎿ ...) or a list marker (- * 1.) starts its own line whatever the
// line before it did: that is how each CLI begins a message, a tool result or
// an item. Box borders (│ and the corners) are stripped without breaking the
// line, since every row inside a box carries one.

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
const TRAILING_GLYPHS = new RegExp(`(?:\\s*[${BORDER}${MARK}])+\\s*$`, 'u');
// A list item, its marker kept: dash, star or plus, or a number with a dot or
// a paren, followed by a space and text.
const LIST_ITEM = /^(?:[-*+]|\d+[.)]) \S/;

// A CLI wraps a few columns short of the terminal's right edge: its own
// padding, a border, a margin. A longest line further in than this did not
// wrap; it is a short line among short lines.
const MAX_RIGHT_GUTTER = 16;

// Columns a string occupies. East Asian wide and fullwidth forms and the
// common emoji blocks take two cells; combining marks take none.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (/\p{M}/u.test(ch)) continue;
    w += WIDE.test(ch) ? 2 : 1;
  }
  return w;
}

// One source line → its text with the gutter gone, whether it begins a line of
// its own in the output, the column its text ends at (trailing border and
// padding excluded), and the width of its first word.
function stripLine(line) {
  const raw = String(line);
  const edge = displayWidth(raw.replace(TRAILING_GLYPHS, '').replace(/\s+$/, ''));
  let text = raw.replace(/\s+/g, ' ').trim();
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
  const firstWord = displayWidth(text.split(' ')[0]);
  return { text, startsLine, edge, firstWord };
}

// `cols` is the terminal width; `startColumn` the column the selection begins
// at, since its first line is the tail of a row and its edge must be measured
// from where that row began.
function smartCopyText(raw, { cols, startColumn = 0 } = {}) {
  const rows = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').split('\n').map(stripLine);
  if (rows.length && rows[0].text) rows[0].edge += startColumn;
  const width = Number.isFinite(cols) && cols > 0 ? cols : null;

  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].text) {
      // Blank, or a rule / box edge with nothing else on it: a separator.
      if (out.length && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].text) end++;
    const block = rows.slice(i, end);
    i = end;

    let wrapColumn = 0;
    for (const row of block) if (row.edge > wrapColumn) wrapColumn = row.edge;
    if (width && wrapColumn > width) wrapColumn = width;
    const wrapped = !width || wrapColumn >= width - MAX_RIGHT_GUTTER;

    // The row the last output line ends with, for a continuation row to test
    // its first word against.
    let last = null;
    for (const row of block) {
      const joins = last && !row.startsLine && wrapped && last.edge + 1 + row.firstWord > wrapColumn;
      if (joins) out[out.length - 1] += ' ' + row.text;
      else out.push(row.text);
      last = row;
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { smartCopyText, stripLine, displayWidth, MAX_RIGHT_GUTTER };
