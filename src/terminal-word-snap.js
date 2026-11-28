// A drag over terminal output covers whole words, as a selection does
// everywhere (word-snap.js): each end of xterm's selection grows to its
// word's edge on the logical (unwrapped) line it sits on. The spaces at an
// end stay, as in code: a line's indentation is part of what a copy pastes.
// A double- or triple-click keeps xterm's own word (a whole path or URL) and
// line.
//
// xterm counts cells, a wide character taking two; this maps the cells of a
// logical line to its text and back. Electron-free, so it is unit-tested
// against a stand-in buffer.

const { snapStart, snapEnd } = require('./word-snap');

// The logical line around buffer row `row`: its text, and for each UTF-16
// unit of it the cell it came from ({ row, col, width }).
function logicalCells(buffer, row) {
  let start = row;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (!line || !line.isWrapped) break;
    start--;
  }
  let text = '';
  const cells = [];
  for (let r = start; r < buffer.length; r++) {
    const line = buffer.getLine(r);
    if (!line || (r > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const width = cell ? cell.getWidth() : 1;
      if (width === 0) continue; // the second half of a wide character
      const chars = (cell && cell.getChars()) || ' ';
      for (let k = 0; k < chars.length; k++) cells.push({ row: r, col: x, width });
      text += chars;
    }
  }
  return { text, cells };
}

// The text index of the first cell at or after (row, col), or the text's
// length past the line's last cell.
function indexAt(cells, row, col) {
  const i = cells.findIndex((c) => c.row > row || (c.row === row && c.col + c.width > col));
  return i < 0 ? cells.length : i;
}

// `range` is xterm's selection, normalized ({ start, end } of { row, column },
// the end exclusive; an end at column 0 of a later row means the end of the
// row before). Returns the snapped selection as { start, end } of
// { bufferRow, col }, the end inclusive (selectTerminalRange's form), or null
// when the snap changes nothing.
function snapTerminalSelection(buffer, cols, range) {
  if (!buffer || !range) return null;
  let endRow = range.end.row;
  let endCol = range.end.column;
  if (endCol === 0 && endRow > range.start.row) { endRow -= 1; endCol = cols; }
  const a = logicalCells(buffer, range.start.row);
  const b = logicalCells(buffer, endRow);
  const from = indexAt(a.cells, range.start.row, range.start.column);
  const to = indexAt(b.cells, endRow, endCol);
  const start = snapStart(a.text, from, { trim: false });
  const end = snapEnd(b.text, to, { trim: false });
  if (start === from && end === to) return null;
  if (start >= a.cells.length || end <= 0) return null;
  const s = a.cells[start];
  const e = b.cells[end - 1];
  if (e.row < s.row || (e.row === s.row && e.col < s.col)) return null;
  return { start: { bufferRow: s.row, col: s.col }, end: { bufferRow: e.row, col: e.col + e.width - 1 } };
}

module.exports = { snapTerminalSelection, logicalCells };
