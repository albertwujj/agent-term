// Tests for the substantial-vs-churn screen-change classifier that feeds
// the job-watch "agent active" clock (src/stream/encoder.js
// isSubstantialChange + src/stream/renderer-watch.js classification).
//
// The regression pinned here: a CLI clearing its task-stats line at the
// exact moment a background job finished used to read as "agent awake at
// the finish" and consume the job's completion notice as superseded. Churn
// — spinner frames, token counters, status-line repaints, and the bottom
// strip shifting when a status line clears — must classify as
// substantial:false; scroll and real content must classify as
// substantial:true.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="t"></div></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.window.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

const { Terminal } = require('@xterm/xterm');
const { countNewRows, isSubstantialChange } = require('../src/stream/encoder');
const rendererWatch = require('../src/stream/renderer-watch');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}

const R = (...texts) => texts.map((text) => ({ text }));

// --- pure classifier ------------------------------------------------------

test('spinner frame change is churn', () => {
  const prev = R('output a', 'output b', '', '✳ Thinking (12s)');
  const next = R('output a', 'output b', '', '✻ Thinking (13s)');
  if (isSubstantialChange(prev, next, 24)) throw new Error('classified substantial');
});

test('status line clearing in place is churn (zero new rows)', () => {
  const prev = R('output a', 'output b', 'task: build #42 · 71%');
  const next = R('output a', 'output b');
  if (countNewRows(prev, next) !== 0) throw new Error('expected 0 new rows');
  if (isSubstantialChange(prev, next, 24)) throw new Error('classified substantial');
});

test('status clear that shifts the bottom strip up is churn (shift-immune)', () => {
  // The input box moves up one row when the stats line above it clears —
  // an index-wise compare sees every box row as changed; text membership
  // sees zero new rows.
  const prev = R('output a', 'output b', 'task: build #42 · 99%', '┌────┐', '│ >  │', '└────┘');
  const next = R('output a', 'output b', '┌────┐', '│ >  │', '└────┘');
  if (countNewRows(prev, next) !== 0) throw new Error('expected 0 new rows');
  if (isSubstantialChange(prev, next, 24)) throw new Error('classified substantial');
});

test('streaming burst is substantial', () => {
  const prev = R('old 1', 'old 2');
  const next = R('old 1', 'old 2', 'new 1', 'new 2', 'new 3', 'new 4', 'new 5');
  if (!isSubstantialChange(prev, next, 24)) throw new Error('classified churn');
});

test('full TUI repaint is substantial', () => {
  const prev = R('menu', 'item a', 'item b');
  const next = R('editor', 'fn main() {', '  body();', '}', 'status: saved');
  if (!isSubstantialChange(prev, next, 24)) throw new Error('classified churn');
});

test('threshold floor: up to 3 in-place new rows is churn on a short window', () => {
  // In-place repaints (same length — a multi-row status area) get the
  // floor; appended rows are the growth clause's business.
  const prev = R('a', 'b', 'x1', 'x2', 'x3', 'x4');
  const churn = R('a', 'b', 'n1', 'n2', 'n3', 'x4');
  const substantial = R('a', 'b', 'n1', 'n2', 'n3', 'n4');
  if (isSubstantialChange(prev, churn, 10)) throw new Error('3 new rows should be churn');
  if (!isSubstantialChange(prev, substantial, 10)) throw new Error('4 new rows should be substantial');
});

test('threshold scales with screen height', () => {
  const prev = R('a', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6');
  const six = R('a', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6');
  // 60-row screen: threshold max(3, ceil(6)) = 6 → 6 new rows still churn.
  if (isSubstantialChange(prev, six, 60)) throw new Error('6 new rows on 60 rows should be churn');
  if (!isSubstantialChange(prev, six, 24)) throw new Error('6 new rows on 24 rows should be substantial');
});

test('fill-phase stream (viewport grows by 2+ new rows) is substantial', () => {
  // Before the first scroll, output persists downward instead of moving
  // baseY — growth must count even below the new-rows floor.
  const prev = R('$ make test', 'compiling a');
  const next = R('$ make test', 'compiling a', 'compiling b', 'linking');
  if (!isSubstantialChange(prev, next, 24)) throw new Error('classified churn');
});

test('single-row growth is churn (blink-spinner guard)', () => {
  // A spinner row erased then redrawn across a poll boundary shows up as
  // shrink, then one-row growth with fresh text — neither is content.
  const mid = R('output a', 'output b');
  const redrawn = R('output a', 'output b', '✳ Thinking (14s)');
  if (isSubstantialChange(mid, redrawn, 24)) throw new Error('regrow classified substantial');
});

test('growth of repeated text is churn', () => {
  const prev = R('tick', 'tock');
  const next = R('tick', 'tock', 'tick', 'tock');
  if (isSubstantialChange(prev, next, 24)) throw new Error('repeats classified substantial');
});

test('repeated text does not count as new (undercount errs toward churn)', () => {
  const prev = R('```', 'code', '```');
  const next = R('```', 'code', '```', '```', 'code');
  if (countNewRows(prev, next) !== 0) throw new Error('repeats counted as new');
});

test('blank rows never count', () => {
  const prev = R('a', '', '');
  const next = R('a', '', '', '', '');
  if (countNewRows(prev, next) !== 0) throw new Error('blanks counted as new');
});

// --- renderer-watch integration (real xterm) ------------------------------

const POLL = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  term.open(document.getElementById('t'));

  const updates = [];
  const flips = [];
  global.window.pty = {
    streamBufferUpdate: (p) => updates.push(p),
    streamBufferFlip: (p) => flips.push(p),
  };
  const stop = rendererWatch.start(term, { pollMs: POLL });

  // Each step: mark, write, wait ≥2 polls, then assert over the pushes the
  // step produced (a tick can land mid-step and split one change into two
  // pushes — the assertions below account for that).
  async function step(data, waitMs = POLL * 3) {
    const mark = updates.length;
    if (data) term.write(data);
    await sleep(waitMs);
    return updates.slice(mark);
  }

  // Churn steps demand NO substantial push — that is the regression
  // guarantee. Output steps demand at least ONE substantial push: a tick
  // landing mid-burst can legitimately capture the first line pre-scroll
  // as churn (the slow-stream case) before the scroll push follows.
  function assertNoneSubstantial(pushes, label) {
    test(label, () => {
      if (!pushes.length) throw new Error('no pushes captured');
      const bad = pushes.find((p) => p.substantial);
      if (bad) throw new Error(`substantial push (rows=${bad.rows.length})`);
    });
  }

  function assertSomeSubstantial(pushes, label) {
    test(label, () => {
      if (!pushes.length) throw new Error('no pushes captured');
      if (!pushes.some((p) => p.substantial)) throw new Error('no substantial push');
    });
  }

  // Boot paint: 30 lines scroll the viewport. First sight and scroll are
  // both substantial.
  let pushes = await step(Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\r\n') + '\r\n');
  assertSomeSubstantial(pushes, 'initial paint + scroll pushes are substantial');

  // Spinner/status repaint: overwrite the bottom viewport row in place.
  pushes = await step('\x1b[24;1H\x1b[2K✳ Thinking (12s · 1.2k tokens)');
  assertNoneSubstantial(pushes, 'status-line paint is churn');

  pushes = await step('\x1b[24;1H\x1b[2K✴ Thinking (13s · 1.4k tokens)');
  assertNoneSubstantial(pushes, 'counter tick is churn');

  // The regression case: the status line clears with no other change.
  pushes = await step('\x1b[24;1H\x1b[2K');
  assertNoneSubstantial(pushes, 'status-line clear is churn');

  // Real output resumes: new lines scroll in.
  pushes = await step(Array.from({ length: 10 }, (_, i) => `more-${i}`).join('\r\n') + '\r\n');
  assertSomeSubstantial(pushes, 'scrolling output is substantial');

  // Alt-screen flip fires the flip channel (main counts it as activity).
  {
    const flipMark = flips.length;
    term.write('\x1b[?1049h');
    await sleep(POLL * 3);
    test('alt-screen flip pushes streamBufferFlip', () => {
      if (flips.length <= flipMark) throw new Error('no flip captured');
    });
  }

  // Full TUI paint in the alternate buffer.
  pushes = await step(
    Array.from({ length: 20 }, (_, i) => `\x1b[${i + 1};1Htui-row-${i}`).join(''));
  assertSomeSubstantial(pushes, 'full TUI repaint is substantial');

  // Single-cell spinner inside the TUI.
  pushes = await step('\x1b[1;1H✵');
  assertNoneSubstantial(pushes, 'TUI spinner cell is churn');

  stop();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
})();
