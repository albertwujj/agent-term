// A sent edit shows the user's marks until the agent's change lands, then the
// page shows the change, driving the REAL src/markdown-viewer.js in jsdom.
//
// The agent replies, then changes the document and re-anchors the thread to
// its new text, then sets the status after its sweep (contract.md). The status
// used to be what consumed an edit, so once the change was on disk its block
// hid behind the box of the user's marks until the status came, often many
// seconds later. A write after the agent's reply is the edit applied.

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
if (!dom.window.Highlight) dom.window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
  || (() => [{ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }]);
dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
  || (() => ({ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }));

const { createMarkdownViewer } = require('../src/markdown-viewer');
const { mergeStoreWithJournal } = require('../src/agent-journal');

const OLD = 'The agent applies this edit here.';
const NEW = 'The agent applies this edit now.';
const source = (middle) => ['# Heading', 'First paragraph stays.', middle, 'Last paragraph stays.'].join('\n\n');
let doc = { content: source(OLD), mtimeMs: 5 };
const store = {
  version: 1,
  turn: 1,
  threads: [{
    id: 't1',
    anchor: { snippet: OLD, context: '', heading: 'Heading' },
    anchor_status: 'ok',
    messages: [{ author: 'user', body: `[Edit]\nThe agent applies this edit <del>here</del><ins>now</ins>.\n[/Edit]`, ts: 10, turn: 1 }],
  }],
};
const journal = [];

const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: doc.content, mtimeMs: doc.mtimeMs, size: doc.content.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: doc.mtimeMs, size: doc.content.length }),
  submitMarkdownThreads: async () => ({ success: true, data: mergeStoreWithJournal(store, journal) }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: mergeStoreWithJournal(store, journal) }),
  addMarkdownThreadMessage: async () => ({ success: true, data: mergeStoreWithJournal(store, journal) }),
  writeMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', mtimeMs: doc.mtimeMs, size: 0 }),
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
const find = (sel) => primary().querySelector(sel);
const shownText = (text) => Array.from(primary().querySelectorAll('p'))
  .some((p) => p.textContent.includes(text) && !p.closest('.md-pending-diff'));
// One store poll, or one doc poll and its debounce.
const POLL = 1400;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(40);
  check('the sent edit shows its marks in place', !!find('p.md-sealed'));

  journal.push({ thread: 't1', body: 'Using "now": the sentence is about the present step.', ts: 20, turn: 1 });
  await sleep(POLL);
  check('the reply ahead of the change keeps the marks', !!find('p.md-sealed') && !shownText(NEW));
  check('and shows the explanation under them', !!find('.md-thread-card.waiting'));

  doc = { content: source(NEW), mtimeMs: 30 };
  journal.push({ thread: 't1', anchor: { snippet: NEW }, ts: 31, turn: 1 });
  await sleep(POLL);
  check('the change written after the reply shows at once', shownText(NEW));
  check('with no marks or box over it', !find('.md-sealed') && !find('.md-pending-diff.sent'));
  check('and the explanation still open under it', !!find('.md-thread-card.waiting'));

  journal.push({ thread: 't1', status: 'resolved', ts: 32, turn: 1 });
  await sleep(POLL);
  check('the status folds the thread', !find('.md-thread-card') && !!find('.md-thread-resolved-line'));
  check('over the change', shownText(NEW));

  viewer.close();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
