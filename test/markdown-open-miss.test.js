// An open that misses, driving the REAL src/markdown-viewer.js in jsdom.
//
// Following a link to a file that is not there used to tear the doc down
// before the read: the poll stopped, the threads cleared and the bar named the
// missing file, and the failure put none of it back. The next redraw brought
// the old doc's text back with nothing refreshing it, so a Send from it went
// out and the agent's answer never landed. Now a doc already up stays live
// until the next one has loaded, and the miss says which path it tried.

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

const { createMarkdownViewer } = require('../src/markdown-viewer');

const DOC = '/fake/notes/doc.md';
const OTHER = '/fake/notes/other.md';
const SLOW = '/fake/notes/slow.md';
const MISSING = '/fake/notes/missing.md';
const ALPHA = 'Alpha paragraph carries the thread.';

const files = {
  [DOC]: { content: ['# Doc', '', ALPHA, '', 'Bravo paragraph is plain.'].join('\n'), mtime: 1 },
  [OTHER]: { content: ['# Other', '', 'Other paragraph lives in the next doc.'].join('\n'), mtime: 1 },
  [SLOW]: { content: ['# Slow', '', 'Slow paragraph arrives late.'].join('\n'), mtime: 1 },
};
let releaseSlow = null;
const statCalls = [];
let storeReads = 0;
const toasts = [];
const store = {
  version: 1,
  turn: 1,
  threads: [{
    id: 't-1',
    anchor: { snippet: ALPHA, context: '', heading: 'Doc' },
    anchor_status: 'ok',
    status: 'resolved',
    messages: [{ author: 'user', body: 'tighten this', ts: 1, turn: 1 }, { author: 'agent', body: 'Tightened.', ts: 2, turn: 1 }],
  }],
};

const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async (path) => {
    if (path === SLOW) await new Promise((resolve) => { releaseSlow = resolve; });
    const file = files[path];
    if (!file) return { success: false, error: 'File not found' };
    return { success: true, path, content: file.content, mtimeMs: file.mtime, size: file.content.length };
  },
  statMarkdownFile: async (path) => {
    statCalls.push(path);
    const file = files[path];
    if (!file) return { success: false, error: 'File not found' };
    return { success: true, path, mtimeMs: file.mtime, size: file.content.length };
  },
  submitMarkdownThreads: async () => ({ success: true, data: store }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/runbook.md' }),
  readMarkdownThreads: async ({ docPath }) => {
    storeReads++;
    return { success: true, data: docPath === DOC ? store : { version: 1, turn: 0, threads: [] } };
  },
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: true, path: DOC, mtimeMs: 2, size: 1 }),
  showToast: (message) => toasts.push(message),
  openURL: noop,
  openDocPath: noop,
  getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
  focusTerminal: noop,
  openSearchBar: noop,
  closeSearchBar: noop,
  getSearchState: () => ({ isOpen: false }),
  onClose: noop,
  platform: 'darwin',
});

const POLL = 1600; // the 1s poll, the 250ms debounce, and slack
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const primary = () => document.querySelector('.md-viewer-body');
const shows = (text) => primary().textContent.includes(text);
const title = () => document.querySelector('.vb-title').textContent;
const threadRow = () => primary().querySelector('[data-md-keep-key="thread:t-1"]');
const errorText = () => (primary().querySelector('.md-viewer-error') || {}).textContent || '';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: DOC });
  await sleep(POLL);
  check('the doc is up with its thread', shows(ALPHA) && !!threadRow());

  // --- a miss while a doc is up leaves that doc as it was ---
  toasts.length = 0;
  const missed = await viewer.open({ filePath: MISSING });
  await sleep(20);
  check('the open reports the miss', missed === false);
  check('the toast names the path it tried', toasts.includes(`File not found: ${MISSING}`), toasts);
  check('the bar still names the doc being read', title() === DOC, title());
  check('the doc stays on the page, no error over it', shows(ALPHA) && !errorText(), errorText());
  check('its threads stay', !!threadRow());

  const readsBefore = storeReads;
  files[DOC] = { content: `${files[DOC].content}\n\nCharlie paragraph is the agent's answer.`, mtime: 2 };
  await sleep(POLL);
  check('the doc still polls its store', storeReads > readsBefore, { readsBefore, storeReads });
  check("and the agent's next write lands", shows("Charlie paragraph is the agent's answer."));

  // --- a hit replaces the doc and retires its poll ---
  check('a doc that loads replaces it', (await viewer.open({ filePath: OTHER })) === true);
  await sleep(20);
  check('the bar and page show the new doc', title() === OTHER && shows('Other paragraph') && !shows(ALPHA), title());
  statCalls.length = 0;
  await sleep(POLL);
  check('only the new doc polls', statCalls.length > 0 && statCalls.every((p) => p === OTHER), statCalls);

  // --- a later open outranks an earlier read still in flight ---
  const slow = viewer.open({ filePath: SLOW });
  await sleep(5);
  check('the later open lands', (await viewer.open({ filePath: DOC })) === true);
  releaseSlow();
  check('the earlier read, landing after, is dropped', (await slow) === false);
  await sleep(20);
  check('the later doc stays up', title() === DOC && shows(ALPHA) && !shows('Slow paragraph'), title());

  // --- a cold miss shows the error in the band, and nothing redraws over it ---
  viewer.close();
  await sleep(20);
  toasts.length = 0;
  check('a cold miss reports it', (await viewer.open({ filePath: MISSING })) === false);
  check('the band says what it tried', errorText() === `File not found: ${MISSING}`, errorText());
  check('and toasts it', toasts.includes(`File not found: ${MISSING}`), toasts);
  viewer.hide();
  await sleep(20);
  viewer.toggle(); // shown again: the redraw that used to bring a closed doc back
  await sleep(40);
  check('a redraw keeps the error, not the last doc', !!errorText() && !shows(ALPHA), primary().textContent.slice(0, 80));

  check('a cold open after the miss loads', (await viewer.open({ filePath: DOC })) === true);
  await sleep(20);
  check('and shows the doc', title() === DOC && shows(ALPHA) && !errorText());
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the viewer's refresh timers keep the loop alive
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
