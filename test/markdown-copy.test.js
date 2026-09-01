// Guards the md viewer's ⧉ copy against the REAL src/markdown-viewer.js in
// jsdom: copy takes what's armed. Nothing armed → the whole body as plain
// text (headings out, paragraphs one-lined, nested list items each their own
// line); a clicked heading → its section's body, sub-section included, up to
// the next heading of its level; a clicked paragraph → that paragraph; the
// modifier variant → the markdown source of the same scope; ⌘C on an armed
// block → the same copy from the keyboard. The bar button's label names the
// scope before the click and returns to "text" when the target clears.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => s };
if (!dom.window.CSS.highlights) dom.window.CSS.highlights = new Map();
if (!dom.window.Highlight) dom.window.Highlight = class { constructor() {} };
dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
  || (() => [{ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }]);
dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
  || (() => ({ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }));

// The viewer writes through the bare `navigator` global (Node's own here).
let copied = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'MacIntel', clipboard: { writeText: async (t) => { copied = t; } } },
});

const { createMarkdownViewer } = require('../src/markdown-viewer');

const FIXTURE = [
  '# Title',
  '',
  'Intro paragraph that wraps',
  'onto a second source line.',
  '',
  '## Alpha',
  '',
  'Alpha body first paragraph.',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '### Alpha sub',
  '',
  'Sub body stays in the section.',
  '',
  '## Beta',
  '',
  'Beta body paragraph.',
].join('\n');

const noop = () => {};
const store = { version: 1, turn: 1, threads: [] };
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: FIXTURE, mtimeMs: 1, size: FIXTURE.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitMarkdownThreads: async () => ({ success: true, data: store }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: true }),
  showToast: noop,
  openURL: noop,
  getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
  focusTerminal: noop,
  openSearchBar: noop,
  closeSearchBar: noop,
  getSearchState: () => ({ isOpen: false }),
  onClose: noop,
  platform: 'darwin',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const primary = () => document.querySelectorAll('.md-viewer-body')[0];
const copyBtn = () => document.querySelector('.md-copy-body');
const key = (init) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

// The innermost block holding the text (an outer list item's text includes
// its nested items').
function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .filter((b) => b.textContent.includes(matchText))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return el;
}

async function pressCopy(init = {}) {
  copied = null;
  copyBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init }));
  await sleep(10);
  return copied;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(30);

  check('button starts as the whole text', copyBtn().textContent === '⧉ text', copyBtn().textContent);
  {
    const text = await pressCopy();
    check('unarmed copy is the whole body, headings out, paragraphs one-lined, nested items once each',
      text === [
        'Intro paragraph that wraps onto a second source line.',
        'Alpha body first paragraph.',
        'one\nnested\ntwo',
        'Sub body stays in the section.',
        'Beta body paragraph.',
      ].join('\n\n'), text);
    check('the flash confirms', copyBtn().textContent === '✓', copyBtn().textContent);
  }

  // --- a clicked heading marks its section ---
  clickBlock('Alpha');
  await sleep(5);
  check('arming a heading relabels the button as the section', copyBtn()._restLabel === '⧉ section', copyBtn()._restLabel);
  {
    const text = await pressCopy();
    check('heading copy is the section body through its sub-section, stopping at the next peer heading',
      text === ['Alpha body first paragraph.', 'one\nnested\ntwo', 'Sub body stays in the section.'].join('\n\n'), text);
    check('the heading stays armed after the copy', !!primary().querySelector('h2.md-comment-target-active'));
  }
  {
    const text = await pressCopy({ metaKey: true });
    check('modifier copy with a heading armed is the section body source, no blank lines around it',
      text === ['Alpha body first paragraph.', '', '- one', '  - nested', '- two', '', '### Alpha sub', '', 'Sub body stays in the section.'].join('\n'), text);
  }

  // --- a sub-heading marks only its own section ---
  clickBlock('Alpha sub');
  await sleep(5);
  {
    const text = await pressCopy();
    check('sub-heading copy is just its own body', text === 'Sub body stays in the section.', text);
  }

  // --- a clicked paragraph is itself ---
  clickBlock('Beta body');
  await sleep(5);
  check('arming a paragraph relabels the button', copyBtn()._restLabel === '⧉ paragraph', copyBtn()._restLabel);
  {
    const text = await pressCopy();
    check('paragraph copy is that paragraph', text === 'Beta body paragraph.', text);
  }

  // --- a nested list item is lifted to column 0 for the source variant ---
  clickBlock('nested');
  await sleep(5);
  check('a list item labels as an item', copyBtn()._restLabel === '⧉ item', copyBtn()._restLabel);
  {
    const text = await pressCopy({ metaKey: true });
    check('nested item source copies dedented', text === '- nested', text);
  }

  // --- ⌘C on an armed block is the keyboard twin ---
  const intro = clickBlock('Intro paragraph');
  await sleep(5);
  copied = null;
  {
    // Arming focuses the viewer shell, so the chord lands inside it.
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
    intro.dispatchEvent(ev);
    await sleep(10);
    check('⌘C with a paragraph armed copies it', copied === 'Intro paragraph that wraps onto a second source line.', copied);
    check('⌘C is consumed', ev.defaultPrevented);
  }

  // --- the letters still comment on an armed heading (no collision) ---
  clickBlock('Beta');
  await sleep(5);
  key({ key: 'n' });
  await sleep(10);
  {
    const ta = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
    check('a letter on an armed heading still opens the comment composer', !!ta && ta.value === 'n', ta && ta.value);
    if (ta) ta.value = '';
  }
  key({ key: 'Escape' });
  await sleep(10);
  check('clearing the target returns the button to the whole text', copyBtn()._restLabel === '⧉ text', copyBtn()._restLabel);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
