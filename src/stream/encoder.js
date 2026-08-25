// xterm buffer → Row[] encoder.
//
// Loaded by the renderer (esbuild bundles via require) because xterm's
// Terminal lives in the renderer process — main has no buffer access.
// See ../../agent-stream-hub/stream.md for the Row / StyleRun schema.

// Color modes returned by xterm's getFgColorMode / getBgColorMode.
// xterm exposes them as packed bit-flags (Attributes.CM_MASK = 0x03000000),
// NOT as small integers — getting this wrong silently drops every color.
const COLOR_MODE_DEFAULT = 0;
const COLOR_MODE_P16     = 0x01000000;
const COLOR_MODE_P256    = 0x02000000;
const COLOR_MODE_RGB     = 0x03000000;

function colorToString(mode, value) {
  if (mode === COLOR_MODE_P16 || mode === COLOR_MODE_P256) return 'p' + value;
  if (mode === COLOR_MODE_RGB) {
    // xterm packs RGB as 0xRRGGBB.
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
  }
  return null;
}

// Snapshot of one cell's style attributes, used for run coalescing.
function styleSnapshot(cell) {
  const fg = colorToString(cell.getFgColorMode(), cell.getFgColor());
  const bg = colorToString(cell.getBgColorMode(), cell.getBgColor());
  const bold = cell.isBold() ? 1 : 0;
  const italic = cell.isItalic() ? 1 : 0;
  const underline = cell.isUnderline() ? 1 : 0;
  const dim = cell.isDim() ? 1 : 0;
  const inverse = cell.isInverse() ? 1 : 0;
  const strike = (typeof cell.isStrikethrough === 'function') ? (cell.isStrikethrough() ? 1 : 0) : 0;
  return { fg, bg, bold, italic, underline, dim, inverse, strike };
}

function snapshotsEqual(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
      && a.underline === b.underline && a.dim === b.dim && a.inverse === b.inverse
      && a.strike === b.strike;
}

function isDefaultSnapshot(s) {
  return s.fg === null && s.bg === null && !s.bold && !s.italic && !s.underline && !s.dim && !s.inverse && !s.strike;
}

function snapshotToStyleRun(s, start, end) {
  const run = { start, end };
  if (s.fg) run.fg = s.fg;
  if (s.bg) run.bg = s.bg;
  if (s.bold) run.bold = true;
  if (s.italic) run.italic = true;
  if (s.underline) run.underline = true;
  if (s.dim) run.dim = true;
  if (s.inverse) run.inverse = true;
  if (s.strike) run.strike = true;
  return run;
}

// Encode a single xterm IBufferLine into a Row. Walks cells to build
// the text and a list of StyleRuns for any non-default styling.
//
// translateToString(true) returns text up to xterm's right-trim point.
// In practice it leaves trailing whitespace whenever cells were ever
// written-then-cleared (their attr stamp differs from "pristine"), even
// though they render blank. We belt-and-suspenders trim after the fact
// so long all-blank-tail rows collapse in the viewer.
function encodeLine(line, cols) {
  if (!line) return { text: '' };
  let text = line.translateToString(true);
  if (text) text = text.replace(/[ \t]+$/, '');
  if (!text) return { text: '' };

  const cell = line.getCell(0);
  if (!cell) return { text };

  const styles = [];
  let runStart = -1;
  let runStyle = null;

  // Walk cells in parallel with the text. Stop as soon as we've covered
  // the trimmed text length — cells beyond that point may carry attrs
  // but their visual content has been intentionally dropped.
  let charIndex = 0;
  let x = 0;
  const xMax = cols || text.length;
  while (charIndex < text.length && x < xMax) {
    const cellRef = line.getCell(x, cell);
    if (!cellRef) break;
    const width = cell.getWidth();
    if (width === 0) { x++; continue; }
    const chars = cell.getChars();
    const snap = styleSnapshot(cell);
    const charLen = chars.length || 1;
    if (runStart < 0) {
      runStart = charIndex;
      runStyle = snap;
    } else if (!snapshotsEqual(snap, runStyle)) {
      if (!isDefaultSnapshot(runStyle)) {
        styles.push(snapshotToStyleRun(runStyle, runStart, charIndex));
      }
      runStart = charIndex;
      runStyle = snap;
    }
    charIndex += charLen;
    x++;
  }
  if (runStart >= 0 && runStyle && !isDefaultSnapshot(runStyle)) {
    styles.push(snapshotToStyleRun(runStyle, runStart, Math.min(charIndex, text.length)));
  }

  const row = { text };
  if (styles.length > 0) row.styles = styles;
  return row;
}

// Encode an absolute row range [start, end) of an xterm buffer to Row[].
// Indices are clamped to the buffer. Trailing all-empty rows are stripped
// (rationale in encodeViewport). The renderer watcher uses this to capture
// the scroll delta since the last poll — starting above the current
// viewport so rows that scrolled off the top between polls are included.
function encodeRange(buffer, start, end, cols) {
  const s = Math.max(0, start);
  const e = Math.min(buffer.length, end);
  const rows = [];
  for (let y = s; y < e; y++) {
    rows.push(encodeLine(buffer.getLine(y), cols));
  }
  while (rows.length > 0 && !rows[rows.length - 1].text) rows.pop();
  return rows;
}

// Encode the viewport of an xterm buffer to Row[]. Trailing all-empty
// rows are stripped — most CLIs (Claude included) only use the top of
// the viewport, and shipping a tail of blanks both wastes bandwidth and
// fights the viewer's auto-scroll (which would otherwise land on empties
// and push the real content above the visible area).
function encodeViewport(buffer, terminalRows, cols) {
  return encodeRange(buffer, buffer.baseY, buffer.baseY + terminalRows, cols);
}

// Cheap content-equality for change detection — text-only. Style changes
// without text changes still trigger a push via cell attrs being part of
// the encoded payload, so this is mainly a fast-path "no work to do" check.
function rowsTextEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] && a[i].text) !== (b[i] && b[i].text)) return false;
  }
  return true;
}

// Substantial-vs-churn classifier for the host's "agent active" clock
// (job-watch's supersede gate). A repaint that brings no new content — a
// spinner frame, a token counter, a status line clearing when a task
// finishes — must not read as the agent waking: exactly such a repaint at
// a background job's finish is what used to consume the job's completion
// notice as "agent awake at the finish". Same near-duplicate idea the hub
// uses to compact snapshot rings (server.js nearlyIdentical), but counted
// on row TEXT membership rather than row position: status churn shifts
// the bottom strip (a status line clearing moves the input box up), which
// an index-wise compare misreads as many changed rows. Undercounting —
// a streamed row repeating text already on screen — errs toward churn,
// the cheap direction: a false "churn" at worst delivers a notice the
// agent also learned of itself; a false "substantial" silently drops one.
function countNewRows(prevRows, nextRows) {
  const seen = new Set();
  for (const r of prevRows || []) {
    const t = (r && r.text) || '';
    if (t) seen.add(t);
  }
  let n = 0;
  for (const r of nextRows || []) {
    const t = (r && r.text) || '';
    if (t && !seen.has(t)) n++;
  }
  return n;
}

// The floor lets a multi-row status area (frame glyph + counter + hint
// line, each with fresh text per frame) stay churn on short windows; the
// ratio scales the allowance on tall ones.
function isSubstantialChange(prevRows, nextRows, screenRows) {
  return countNewRows(prevRows, nextRows) > Math.max(3, Math.ceil(0.1 * (screenRows || 0)));
}

module.exports = { encodeLine, encodeRange, encodeViewport, rowsTextEqual, countNewRows, isSubstantialChange };
