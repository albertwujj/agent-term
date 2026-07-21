// Unit tests for Claude Code image-attachment reassembly.
// Run with: node test/image-attachment.test.js
//
// Claude Code prints `› [image]<path> (<size>)` and, when the path outruns the
// row, hangs the remainder onto following rows indented to the path column while
// pinning the size to the first row. These are hard newlines, so the path is
// split mid-token with the size annotation between the pieces. The functions
// below (duplicated from renderer.js, per this suite's convention) stitch the
// pieces back into one clickable path.

// --- deps copied from renderer.js ------------------------------------------
const RESOURCE_EXTENSIONS = /\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?|pdf|docx?|xlsx?|pptx?|rtf|epub|mp[34]|wav|avi|mov|mkv|flac|ogg|webm|zip|tgz|gz|bz2|xz|rar|7z|zst|csv|tsv|parquet|avro)$/i;
const DISPLAY_PATH_PREFIX = /^(?:\.\.\.|…)(?:[\\/]+|[^\\/]+[\\/]+)/;
const TRAILING_PATH_PUNCTUATION = /[.,;:!?]+$/;
function normalizeNavigablePath(text) {
  if (!text) return null;
  let normalized = text.replace(DISPLAY_PATH_PREFIX, '');
  normalized = normalized.replace(TRAILING_PATH_PUNCTUATION, '');
  return normalized || null;
}

// --- functions under test (duplicated from renderer.js) --------------------
const IMAGE_ATTACHMENT_MARKER = '[image]';
const IMAGE_SIZE_ANNOTATION = /\s+\(\s*[<~]?\s*\d[\d.,]*\s?(?:[KMGT]i?)?B\)\s*$/i;

function parseImageAttachmentHead(rowText) {
  const text = String(rowText == null ? '' : rowText).replace(/\s+$/, '');
  const markerIdx = text.indexOf(IMAGE_ATTACHMENT_MARKER);
  if (markerIdx === -1) return null;
  const afterMarker = markerIdx + IMAGE_ATTACHMENT_MARKER.length;
  const pathCol = afterMarker + text.slice(afterMarker).match(/^\s*/)[0].length;
  const head = text.slice(pathCol).replace(IMAGE_SIZE_ANNOTATION, '');
  if (!head || /\s/.test(head)) return null;
  return { markerCol: markerIdx, pathCol, head };
}

function analyzeImageAttachment(buffer, headRow) {
  const headLine = buffer.getLine(headRow);
  if (!headLine) return null;
  const parsed = parseImageAttachmentHead(headLine.translateToString());
  if (!parsed) return null;
  const { markerCol, pathCol, head } = parsed;

  const segments = [{ row: headRow, col: pathCol, width: head.length, text: head }];
  let full = head;
  let endRow = headRow;

  const complete = () => RESOURCE_EXTENSIONS.test(normalizeNavigablePath(full) || full);
  for (let row = headRow + 1; !complete() && row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    const raw = line.translateToString().replace(/\s+$/, '');
    if (raw.length <= markerCol || raw.slice(0, markerCol).trim() !== '') break;
    const fragCol = markerCol + raw.slice(markerCol).match(/^\s*/)[0].length;
    const frag = raw.slice(fragCol);
    if (!frag || /\s/.test(frag) || frag.includes(IMAGE_ATTACHMENT_MARKER)) break;
    segments.push({ row, col: fragCol, width: frag.length, text: frag });
    full += frag;
    endRow = row;
  }

  if (!complete()) return null;
  return { headRow, endRow, pathCol, fullPath: normalizeNavigablePath(full) || full, segments };
}

function imageAttachmentMatchAt(buffer, bufferRow, col) {
  for (let h = bufferRow; h >= 0 && h >= bufferRow - 24; h--) {
    const line = buffer.getLine(h);
    if (!line || !parseImageAttachmentHead(line.translateToString())) continue;
    const analysis = analyzeImageAttachment(buffer, h);
    if (analysis && analysis.endRow >= bufferRow) {
      const seg = analysis.segments.find(
        (s) => s.row === bufferRow && col >= s.col && col < s.col + s.width,
      );
      if (seg) return { patternName: 'image_attachment', fullPath: analysis.fullPath, text: seg.text };
    }
    if (h === bufferRow) break;
  }
  return null;
}

// --- harness ---------------------------------------------------------------
// Fake xterm buffer: rows padded to `cols` (translateToString returns the full
// row, trailing spaces and all, as xterm does).
function makeBuffer(rows, cols = 200) {
  const lines = rows.map((r) => (r + ' '.repeat(Math.max(0, cols - r.length))).slice(0, cols));
  return { length: lines.length, getLine: (i) => (i >= 0 && i < lines.length ? { translateToString: () => lines[i] } : null) };
}

let passed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; } else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const P = ' '.repeat(11); // path column for "  › [image]"

// The exact split from the field report: path broken mid-name, size pinned to
// row 1, remainder hanging under the path on row 2.
const head1 = '  › [image]/private/tmp/claude-502/-Users-yunxin-agent-term/1ad84b74-4a72-4235-a79d-0c3ce03b4ae1/scratchpad/shot-recap-01-fi (422KB)';
const cont1 = P + 'rst.png';
const head2 = '  › [image]/private/tmp/claude-502/-Users-yunxin-agent-term/1ad84b74-4a72-4235-a79d-0c3ce03b4ae1/scratchpad/shot-recap-03-la (331KB)';
const cont2 = P + 'st.png';
const buf = makeBuffer([head1, cont1, head2, cont2]);

const a = analyzeImageAttachment(buf, 0);
check('stitches split path to full name', a && a.fullPath.endsWith('scratchpad/shot-recap-01-first.png'), a && a.fullPath);
check('pathCol is column after [image]', a && a.pathCol === 11, a && a.pathCol);
check('span ends on the continuation row', a && a.endRow === 1, a && a.endRow);
check('two on-screen segments', a && a.segments.length === 2 && a.segments[1].text === 'rst.png');

const a2 = analyzeImageAttachment(buf, 2);
check('second attachment stitches independently', a2 && a2.fullPath.endsWith('shot-recap-03-last.png'), a2 && a2.fullPath);
check('analysis on a continuation row is null', analyzeImageAttachment(buf, 1) === null);

// Click resolution across the span.
check('click on head-row path resolves', imageAttachmentMatchAt(buf, 0, 30)?.fullPath === a.fullPath);
check('click on continuation resolves to same path', imageAttachmentMatchAt(buf, 1, 13)?.fullPath === a.fullPath);
check('click in the "  › [image]" prefix does not resolve', imageAttachmentMatchAt(buf, 0, 3) === null);
check('click on the size annotation does not resolve', imageAttachmentMatchAt(buf, 0, head1.replace(/\s+$/, '').length - 2) === null);
check('continuation of 2nd attachment resolves to 2nd path', imageAttachmentMatchAt(buf, 3, 13)?.fullPath === a2.fullPath);

// A path that already fits on one row: no continuation, handled as one segment.
const single = makeBuffer(['  › [image]/tmp/pic.png (12KB)', '  › unrelated']);
const s = analyzeImageAttachment(single, 0);
check('single-line path resolves whole', s && s.fullPath === '/tmp/pic.png' && s.endRow === 0 && s.segments.length === 1, s && s.fullPath);
check('single-line does not absorb the next row', s && s.endRow === 0);

// A three-row wrap.
const three = makeBuffer([
  '  › [image]/very/long/path/that/keeps/going/and/going/aaaaaaaaaaaaaaaaaa (9KB)',
  P + 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  P + 'cccc.jpeg',
]);
const t = analyzeImageAttachment(three, 0);
check('three-row wrap stitches all fragments', t && t.endRow === 2 && t.fullPath.endsWith('cccc.jpeg'), t && `${t.endRow} ${t && t.fullPath}`);

// Rejections: no marker, unresolved (no resource extension), fragment left of
// the marker (Ink never hangs the wrap left of "[image]").
check('ordinary output is not an attachment', analyzeImageAttachment(makeBuffer(['just some output']), 0) === null);
check('unresolved truncation (no continuation) is null',
  analyzeImageAttachment(makeBuffer(['  › [image]/tmp/scratch/shot-recap-01-fi (422KB)', 'unindented line']), 0) === null);
check('a fragment indented left of the [image] marker is not absorbed',
  analyzeImageAttachment(makeBuffer(['  › [image]/tmp/scratch/shot-recap-01-fi (422KB)', '  rst.png']), 0) === null);

// Regression: Claude Code prints a SPACE after the marker ("[image] /path"),
// and hangs the wrap under the path's first char. The head must skip that space
// (else it reads as an interior space and rejects the row), and the split must
// still stitch. This is the exact "first goes to ide route" field report.
const spaced = makeBuffer([
  '  › [image] /private/tmp/claude-502/-Users-yunxin-agent-term/1ad84b74/scratchpad/shot-live-2.p (398.4KB)',
  ' '.repeat(12) + 'ng',                       // hangs under '/', one past ']'+space
  '  › [image] /private/tmp/claude-502/-Users-yunxin-agent-term/1ad84b74/scratchpad/shot-live-1.png (422KB)',
]);
const sp1 = analyzeImageAttachment(spaced, 0);
check('spaced marker: pathCol lands on the path, not the space', sp1 && sp1.pathCol === 12, sp1 && sp1.pathCol);
check('spaced marker: split path stitches to .png', sp1 && sp1.fullPath.endsWith('shot-live-2.png') && sp1.endRow === 1, sp1 && sp1.fullPath);
check('spaced marker: continuation segment sits under the fragment', sp1 && sp1.segments[1].col === 12 && sp1.segments[1].text === 'ng');
check('spaced marker: click on the split head resolves (not ide)', imageAttachmentMatchAt(spaced, 0, 30)?.fullPath === sp1.fullPath);
const sp2 = analyzeImageAttachment(spaced, 2);
check('spaced marker: complete-on-one-row path resolves whole', sp2 && sp2.fullPath.endsWith('shot-live-1.png') && sp2.endRow === 2, sp2 && sp2.fullPath);

// Continuation indented one column PAST the path column (Ink over-indent): the
// fragment must still be picked up, trimming the extra lead.
const over = makeBuffer([
  '  › [image]/tmp/scratch/shot-live-2.p (398.4KB)',   // no space after marker: pathCol = 11
  ' '.repeat(12) + 'ng',                                // hangs at col 12, one past pathCol
]);
const ov = analyzeImageAttachment(over, 0);
check('over-indented continuation still stitches', ov && ov.fullPath.endsWith('shot-live-2.png') && ov.segments[1].col === 12, ov && ov.fullPath);

// THE field-report regression: with a space after the marker, Ink hangs the
// wrap under the "[image]" region — a column or two LEFT of the path's first
// char (pathCol = 12). Anchoring the blank-prefix check at pathCol dropped these
// (analysis went null → click fell through to the IDE). Anchor at the marker so
// every plausible hang column (10, 11, 12, 13) still stitches.
for (const indent of [10, 11, 12, 13]) {
  const b = makeBuffer([
    '  › [image] /private/tmp/claude-502/-Users-yunxin-agent-term/1ad84b74/scratchpad/shot-live-2.p (398.4KB)',
    ' '.repeat(indent) + 'ng',
    '(base) yunxin@host agent-term %',            // shell prompt right below — must NOT be absorbed
  ]);
  const r = analyzeImageAttachment(b, 0);
  check(`hang indent ${indent} (left of pathCol) still stitches to .png`,
    r && r.fullPath.endsWith('shot-live-2.png') && r.endRow === 1 && r.segments[1].text === 'ng' && r.segments[1].col === indent,
    r && `${r.fullPath} endRow=${r && r.endRow}`);
  check(`hang indent ${indent}: click on head resolves (not ide)`, imageAttachmentMatchAt(b, 0, 30)?.fullPath === r.fullPath);
  check(`hang indent ${indent}: click on the hanging fragment resolves`, imageAttachmentMatchAt(b, 1, indent)?.fullPath === r.fullPath);
}

// A flush-left line below a truncated head is NOT a continuation (guards the
// shell prompt / next output from being swallowed).
const truncated = makeBuffer(['  › [image] /tmp/scratch/shot-live-2.p (398.4KB)', '(base) yunxin@host %']);
check('flush-left line below is not absorbed', analyzeImageAttachment(truncated, 0) === null);

// Size-annotation shapes.
check('decimal + spaced unit size parses', analyzeImageAttachment(makeBuffer(['  › [image]/a/b/photo.jpeg (1.2 MB)']), 0)?.fullPath === '/a/b/photo.jpeg');
check('"< 1 KB" size parses', analyzeImageAttachment(makeBuffer(['  › [image]/a/b/tiny.gif (<1KB)']), 0)?.fullPath === '/a/b/tiny.gif');

if (failures.length) {
  console.log(`\nimage-attachment: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`image-attachment: ${passed} passed`);
