// Copy a terminal selection as message text: what the copy chord does
// (Cmd/Ctrl+C); Shift added keeps the terminal layout.
//
// Agent output is laid out for the terminal: the CLI hard-wraps prose at the
// column width, prefixes lines with its gutter (⏺ ⎿ › • and box borders), and
// pads with spaces. A verbatim copy keeps all of that, so a pasted passage
// lands in a chat as a paragraph chopped into 80-column lines with glyphs down
// the left edge. This copy removes what is certainly layout and keeps every
// word as written: a stray glyph left behind is one delete, a missing
// apostrophe in every sentence is a rewrite. The viewer's ⧉ plain copy uses
// the same shape (docs/copy.md), so "copy for a message" means one thing
// across the app. The rules, as a user can hold them:
//
// Glyphs. Only what a CLI draws as gutter goes, and only at a line's edges:
// the marks before a message or a tool result (⏺ ⎿ • ◦ ● ▪ ▸ › ❯ ✻ ✦ and
// spinner frames), the > before an echoed prompt, and box borders. Symbols in
// the text stay: a leading ✅ or → or ⚠ is the agent's, a │ between table
// cells is the table's.
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
// short lines. A line filled to the last column that ends mid-path or mid-URL
// was broken by character, and rejoins without a space. Blocks are what blank
// lines separate, each measured on its own: a prompt box and the paragraph
// after it wrap a few columns apart, and a message's column must not be
// judged by its neighbour's.
//
// Indentation. A line that keeps its break keeps its indentation relative to
// the block's left edge, so code and nested lists come through; a line that
// starts with a gutter mark starts flush, and so does the selection's first
// line, whose left edge is wherever the selection began. Whitespace inside a
// line is untouched. A line that starts with a gutter mark or a list marker
// (- * 1.) starts its own line whatever the line before it did: that is how
// each CLI begins a message, a tool result or an item. A blank line stays a
// blank line; a rule or a box edge on its own becomes one; a table rule
// (a line of rule glyphs with a junction in it) vanishes, so the rows of a
// table stay together.

// Box drawing and block elements. Stripped at either edge of a line; never a
// line break on their own. `|` covers terminals that draw borders in ASCII,
// at the start only: a trailing `|` is a markdown table row, which stays.
const BORDER = '\\u2500-\\u259F';
// Gutter marks: ⏺ ⎿ (claude), • › (codex), ✦ (gemini), ● ◦ ▪ ▸ ▶ ❯ and the
// spinner frames ✻ ✽ ✶ ✳ ✢ and braille. Stripped at the start, where the
// line is a new one.
const MARK = '\\u23FA\\u23BF\\u2022\\u203A\\u2726\\u25CF\\u25E6\\u25AA\\u25B8\\u25B6\\u276F\\u273B\\u273D\\u2736\\u2733\\u2722\\u2800-\\u28FF';

const LEADING_SPACE = /^[ \t]+/;
const LEADING_BORDER = new RegExp(`^[${BORDER}|]+`, 'u');
const LEADING_MARK = new RegExp(`^[${MARK}>]+`, 'u');
const TRAILING_BORDER = new RegExp(`[${BORDER}]+$`, 'u');
// A table rule: nothing but rule glyphs, with a junction (├ ┤ ┬ ┴ ┼, or | and
// + in ASCII and markdown tables) among them.
const TABLE_RULE = /^[\s─-▟|+\-=:]*[├┤┬┴┼╞╡╤╧╪|+][\s─-▟|+\-=:]*$/u;
// A list item, its marker kept: dash, star or plus, or a number with a dot or
// a paren, followed by a space and text.
const LIST_ITEM = /^(?:[-*+]|\d+[.)]) \S/;

// A CLI wraps a few columns short of the terminal's right edge: its own
// padding, a border, a margin. A longest line further in than this did not
// wrap; it is a short line among short lines.
const MAX_RIGHT_GUTTER = 16;

// Columns a string occupies. East Asian wide and fullwidth forms and the
// common emoji blocks take two cells; combining marks take none.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (/\p{M}/u.test(ch)) continue;
    w += WIDE.test(ch) ? 2 : 1;
  }
  return w;
}

// One source line → what it contributes:
//   text        its content, gutter gone at both edges, inside untouched
//   kind        'text', 'blank', 'rule' (a table rule) or 'edge' (a box edge
//               or a horizontal rule on its own)
//   indent      the column its content begins at
//   edge        the column it ends at (trailing border and padding excluded)
//   marked      it began with a gutter mark
//   startsLine  it begins a line of its own in the output (a mark or a list item)
//   firstWord   the width of its first word, for the join test
//   lastWord    its last word, for the mid-path test
function stripLine(line) {
  let rest = String(line);
  let indent = 0;
  let marked = false;
  for (;;) {
    let m = LEADING_SPACE.exec(rest);
    if (m) { indent += m[0].length; rest = rest.slice(m[0].length); continue; }
    m = LEADING_BORDER.exec(rest);
    if (m) { indent += displayWidth(m[0]); rest = rest.slice(m[0].length); continue; }
    m = LEADING_MARK.exec(rest);
    if (m) { indent += displayWidth(m[0]); rest = rest.slice(m[0].length); marked = true; continue; }
    break;
  }
  const text = rest.replace(/\s+$/, '').replace(TRAILING_BORDER, '').replace(/\s+$/, '');
  // The rule test reads the whole row: a markdown rule's leading | is a
  // border to the strip above, and the dashes after it would pass as text.
  const kind = !/\S/.test(line) ? 'blank' : TABLE_RULE.test(line) ? 'rule' : text ? 'text' : 'edge';
  const words = text.split(/\s+/);
  return {
    text,
    kind,
    indent,
    edge: indent + displayWidth(text),
    marked,
    startsLine: marked || LIST_ITEM.test(text),
    firstWord: displayWidth(words[0]),
    lastWord: words[words.length - 1],
  };
}

// `cols` is the terminal width; `startColumn` the column the selection begins
// at, since its first line is the tail of a row and its edge must be measured
// from where that row began.
function smartCopyText(raw, { cols, startColumn = 0 } = {}) {
  const rows = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').split('\n').map(stripLine);
  if (rows.length && rows[0].kind === 'text') {
    rows[0].indent += startColumn;
    rows[0].edge += startColumn;
  }
  const width = Number.isFinite(cols) && cols > 0 ? cols : null;

  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'text') {
      // A blank line, a rule or a box edge on its own: a separator. A table
      // rule only ends the block, so the table's rows stay together.
      if (rows[i].kind !== 'rule' && out.length && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === 'text') end++;
    const block = rows.slice(i, end);
    const first = i === 0;
    i = end;

    let wrapColumn = 0;
    let leftEdge = Infinity;
    for (const row of block) {
      if (row.edge > wrapColumn) wrapColumn = row.edge;
      if (!row.marked && row.indent < leftEdge) leftEdge = row.indent;
    }
    if (width && wrapColumn > width) wrapColumn = width;
    const wrapped = !width || wrapColumn >= width - MAX_RIGHT_GUTTER;

    // The row the last output line ends with, for a continuation row to test
    // its first word against.
    let last = null;
    block.forEach((row, n) => {
      const joins = last && !row.startsLine && wrapped && last.edge + 1 + row.firstWord > wrapColumn;
      if (joins) {
        // Filled to the last column and ending mid-path: broken by character.
        const glue = last.edge === wrapColumn && /\//.test(last.lastWord) ? '' : ' ';
        out[out.length - 1] += glue + row.text;
      } else {
        const pad = (first && n === 0) || row.marked ? 0 : row.indent - leftEdge;
        out.push(' '.repeat(Math.max(0, pad)) + row.text);
      }
      last = row;
    });
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { smartCopyText, stripLine, displayWidth, MAX_RIGHT_GUTTER };
