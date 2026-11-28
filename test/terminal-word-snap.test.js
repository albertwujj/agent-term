// A drag over terminal output covers whole words (src/terminal-word-snap.js):
// each end of xterm's selection grows to its word's edge on its logical line,
// across wrapped rows and wide characters, keeping the spaces at its ends.

const { snapTerminalSelection } = require('../src/terminal-word-snap');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

// A stand-in xterm buffer: rows of `cols` cells, a wide (CJK) character
// taking two, the second of width 0. `wrapped` rows continue the row before.
function buffer(cols, rows) {
  const lines = rows.map(({ text, wrapped = false }) => {
    const cells = [];
    for (const ch of text) {
      const wide = /[　-鿿]/.test(ch);
      cells.push({ chars: ch, width: wide ? 2 : 1 });
      if (wide) cells.push({ chars: '', width: 0 });
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 });
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x) => ({ getChars: () => cells[x].chars, getWidth: () => cells[x].width }),
    };
  });
  return { length: lines.length, getLine: (r) => lines[r] };
}
// The text a snapped selection covers, read back off the stand-in rows.
function covered(rows, snapped) {
  let out = '';
  for (let r = snapped.start.bufferRow; r <= snapped.end.bufferRow; r++) {
    const chars = [];
    for (const ch of rows[r].text) { chars.push(ch); if (/[　-鿿]/.test(ch)) chars.push(''); }
    const from = r === snapped.start.bufferRow ? snapped.start.col : 0;
    const to = r === snapped.end.bufferRow ? snapped.end.col + 1 : chars.length;
    out += chars.slice(from, to).join('');
  }
  return out;
}
const sel = (sr, sc, er, ec) => ({ start: { row: sr, column: sc }, end: { row: er, column: ec } });

{
  const rows = [{ text: 'the poller reads the file' }];
  const b = buffer(40, rows);
  const snapped = snapTerminalSelection(b, 40, sel(0, 6, 0, 13)); // "ller re"
  check('a drag inside two words grows to both', snapped && covered(rows, snapped) === 'poller reads', snapped && covered(rows, snapped));
  check('a selection already on word edges is left as it is', snapTerminalSelection(b, 40, sel(0, 4, 0, 10)) === null);
  const spaced = snapTerminalSelection(b, 40, sel(0, 3, 0, 8)); // " poll"
  check('the spaces at an end stay', spaced && covered(rows, spaced) === ' poller', spaced && covered(rows, spaced));
}
{
  const rows = [{ text: '  src/word-snap.js:42 failed' }];
  const b = buffer(40, rows);
  const snapped = snapTerminalSelection(b, 40, sel(0, 8, 0, 12)); // "rd-s"
  check('a path splits at its punctuation', snapped && covered(rows, snapped) === 'word-snap.js', snapped && covered(rows, snapped));
  const indented = snapTerminalSelection(b, 40, sel(0, 0, 0, 4)); // "  sr"
  check('a line\'s indentation stays', indented && covered(rows, indented) === '  src', indented && covered(rows, indented));
}
{
  // "the poller reads" wrapped after "pol" at 7 columns.
  const rows = [{ text: 'the pol' }, { text: 'ler rea', wrapped: true }, { text: 'ds' , wrapped: true }];
  const b = buffer(7, rows);
  const snapped = snapTerminalSelection(b, 7, sel(0, 5, 1, 1)); // "ol" + "l"
  check('a word wrapped across rows snaps on its logical line', snapped && covered(rows, snapped) === 'poller', snapped && covered(rows, snapped));
  const end = snapTerminalSelection(b, 7, sel(1, 4, 2, 0)); // "rea", ending at the row's end
  check('an end at a row\'s end grows into the wrapped row after', end && covered(rows, end) === 'reads', end && covered(rows, end));
}
{
  const rows = [{ text: 'ok 我们今天开会 done' }];
  const b = buffer(40, rows);
  const snapped = snapTerminalSelection(b, 40, sel(0, 6, 0, 8)); // the second half of 们 through 今
  check('wide characters snap by Unicode words, two cells each', snapped && /^我们/.test(covered(rows, snapped)), snapped && covered(rows, snapped));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
