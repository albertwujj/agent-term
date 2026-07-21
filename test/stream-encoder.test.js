// Regression tests for src/stream/encoder.js
//
// The original encoder shipped with wrong color-mode constants (1/2 instead
// of xterm's bit-flags 0x01000000 / 0x02000000 / 0x03000000), which silently
// dropped every fg/bg color from streamed blocks while bold/dim/underline
// still flowed through. These tests pin the encoder's color contract so
// that mismatch can't recur.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="t"></div></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.window.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

const { Terminal } = require('@xterm/xterm');
const { encodeRange, encodeViewport } = require('../src/stream/encoder');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}

function makeTerm() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  term.open(document.getElementById('t'));
  return term;
}

function encodeAfterWrite(term, lines, cb) {
  for (const l of lines) term.write(l + '\r\n');
  return new Promise(resolve => setTimeout(() => {
    const rows = encodeViewport(term.buffer.active, term.rows, term.cols);
    resolve(rows);
  }, 50));
}

(async () => {
  await (async () => {
    const term = makeTerm();
    const rows = await encodeAfterWrite(term, [
      '\x1b[32mGREEN\x1b[0m',                        // P16 palette
      '\x1b[38;5;208mORANGE\x1b[0m',                 // P256 palette
      '\x1b[38;2;100;200;50mRGB\x1b[0m',             // truecolor
      '\x1b[1;31mBOLDRED\x1b[0m',                    // bold + P16
      '\x1b[2;90mDIMGRAY\x1b[0m',                    // dim + P16
      'plain',
    ]);

    test('P16 fg encodes as p<index>', () => {
      const r = rows[0];
      if (!r.styles || !r.styles.length) throw new Error('no styles for P16');
      const s = r.styles[0];
      if (s.fg !== 'p2') throw new Error(`fg=${s.fg}, want p2`);
      if (s.start !== 0 || s.end !== 5) throw new Error(`range ${s.start}-${s.end}, want 0-5`);
    });

    test('P256 fg encodes as p<index>', () => {
      const s = rows[1].styles[0];
      if (s.fg !== 'p208') throw new Error(`fg=${s.fg}, want p208`);
    });

    test('RGB fg encodes as #rrggbb', () => {
      const s = rows[2].styles[0];
      if (s.fg !== '#64c832') throw new Error(`fg=${s.fg}, want #64c832`);
    });

    test('bold + P16 fg both present', () => {
      const s = rows[3].styles[0];
      if (s.fg !== 'p1' || !s.bold) throw new Error(`got ${JSON.stringify(s)}`);
    });

    test('dim + P16 fg both present', () => {
      const s = rows[4].styles[0];
      if (s.fg !== 'p8' || !s.dim) throw new Error(`got ${JSON.stringify(s)}`);
    });

    test('plain text emits no styles', () => {
      if (rows[5].styles) throw new Error('plain row should have no styles');
    });
  })();

  await (async () => {
    const term = makeTerm();
    // 5 content rows then nothing — terminal viewport is 24 rows tall, so
    // baseY..baseY+24 should otherwise contain 19 trailing empties.
    const rows = await encodeAfterWrite(term, [
      'first',
      'second',
      '',           // intentional blank in middle
      'fourth',
      'fifth',
    ]);

    test('trims trailing empty rows', () => {
      if (rows.length !== 5) throw new Error(`got ${rows.length} rows, want 5 (with middle blank kept)`);
      if (rows[2].text !== '') throw new Error('middle blank row was dropped');
      if (rows[4].text !== 'fifth') throw new Error(`last row text=${JSON.stringify(rows[4].text)}, want "fifth"`);
    });
  })();

  // Delta capture: the renderer watcher captures [prevBaseY, bottom) each
  // poll instead of just the viewport, so rows that scroll off the top
  // between polls aren't dropped. This mirrors renderer-watch.js's normal-
  // buffer path and asserts losslessness across a burst that scrolls far
  // more than one viewport between polls — the exact case that used to
  // truncate the viewer.
  await (async () => {
    const term = makeTerm();   // 80 cols, 24 rows
    const all = [];
    for (let i = 0; i < 120; i++) all.push('line-' + i);

    let prevBaseY = null;
    const deltas = [];
    async function writeThenPoll(lines) {
      for (const l of lines) term.write(l + '\r\n');
      await new Promise((r) => setTimeout(r, 50));
      const buf = term.buffer.active;
      const baseY = buf.baseY;
      const bottom = Math.min(buf.length, baseY + term.rows);
      const begin = (prevBaseY === null) ? baseY : Math.min(prevBaseY, baseY);
      const rows = encodeRange(buf, begin, bottom, term.cols);
      prevBaseY = baseY;
      deltas.push(rows);
      return rows;
    }

    await writeThenPoll(all.slice(0, 20));    // no scroll yet (< 24 rows)
    const burst = await writeThenPoll(all.slice(20, 90));  // scrolls ~70 rows
    await writeThenPoll(all.slice(90, 120));

    const captured = new Set();
    for (const rows of deltas) for (const r of rows) if (r.text) captured.add(r.text);

    test('delta capture loses no rows across a fast scroll burst', () => {
      const missing = all.filter((t) => !captured.has(t));
      if (missing.length) throw new Error(`dropped ${missing.length} rows, e.g. ${missing.slice(0, 5).join(', ')}`);
    });

    test('burst delta exceeds one viewport (scenario is actually lossy for viewport-only)', () => {
      // If the burst delta were <= a viewport, viewport-only capture would
      // have sufficed and this test would prove nothing. >24 rows confirms
      // the gap that the old path dropped was really captured here.
      if (burst.length <= term.rows) throw new Error(`burst delta only ${burst.length} rows; need > ${term.rows} to exercise the gap`);
    });

    test('viewport-only capture WOULD have dropped rows (control)', () => {
      // Same buffer, viewport-only: only the last 24 rows are ever seen by
      // any single poll, so mid-burst rows are absent.
      const vp = encodeViewport(term.buffer.active, term.rows, term.cols);
      const vpText = new Set(vp.map((r) => r.text).filter(Boolean));
      if (vpText.has('line-40')) throw new Error('expected line-40 to be absent from the final viewport');
    });
  })();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
})();
