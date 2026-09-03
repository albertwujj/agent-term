// A reply composer's exits, driving the REAL src/markdown-viewer.js in jsdom.
//
// Click-away used to leave the reply composer open, and while it was open the
// document keydown handler swallowed every key page-wide — so after clicking
// away and selecting other text, typing to comment did nothing. Now a click
// away collapses the reply: its text rests in the card as a draft row (the
// comment bubble's click-away grammar — typed text is never lost to a stray
// click), the click acts as usual, and keys land where they are typed.

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

const FIXTURE = [
  '# Heading Words Here',
  '',
  'First paragraph carries the thread blocked on the user.',
  '',
  'Second paragraph is plain text with nothing attached to it.',
  '',
  'Third paragraph is also plain text.',
].join('\n');

const store = {
  version: 1,
  turn: 2,
  threads: [
    {
      id: 't-needs',
      anchor: { snippet: 'First paragraph carries the thread blocked on the user.' },
      anchor_status: 'ok',
      status: 'open',
      messages: [
        { author: 'user', body: 'Is the first one right?', ts: 1, turn: 1 },
        { author: 'agent', body: 'Which half do you mean?', ts: 2, turn: 2 },
      ],
    },
  ],
};

const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: FIXTURE, mtimeMs: 1, size: FIXTURE.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitMarkdownThreads: async () => ({ success: true, data: store }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', mtimeMs: 1, size: 0 }),
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
const articles = () => Array.from(document.querySelectorAll('.md-viewer-body'));
const primary = () => articles()[0];
const find = (sel) => primary().querySelector(sel);
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const armed = () => !!find('.md-comment-target-active');
const key = (k, target = document) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: k }));

function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes(matchText));
  if (!el) throw new Error(`no block matching ${matchText}`);
  click(el);
  return el;
}
function openReply() {
  const btn = Array.from(find('.md-thread-card.needs-user').querySelectorAll('button')).find((b) => b.textContent === 'Reply');
  click(btn);
  return find('.md-thread-reply textarea');
}
function typeInto(ta, text) {
  ta.value = text;
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
const draftRows = () => articles().map((a) => a.querySelector('.md-thread-draft-mark'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(40);
  check('the blocked thread renders as a card', !!find('.md-thread-card.needs-user'));

  // --- click-away with text: collapse to a draft row, the click still acts ---
  let ta = openReply();
  check('Reply opens the composer', !!ta);
  typeInto(ta, 'ab');
  clickBlock('Second paragraph');
  await sleep(20);
  check('a click away closes the composer', !find('.md-thread-reply'));
  check('the click still armed its block', armed());
  check('the typed text rests as a draft row in both copies',
    draftRows().every((r) => r && r.textContent === 'ab'), draftRows().map((r) => r && r.textContent));
  check('the Reply button gave way to the row', !find('.md-thread-card.needs-user .md-thread-actions'));

  // --- keys land on the page again: a letter on the armed block opens a comment ---
  key('a');
  await sleep(20);
  check('typing on the armed block opens the comment bubble', !!find('.md-comment-card'));
  key('Escape');
  await sleep(20);
  check('Escape closes the bubble', !find('.md-comment-card'));

  // --- the row reopens the composer seeded with the draft; Escape retreats ---
  click(find('.md-thread-draft-mark'));
  await sleep(20);
  ta = find('.md-thread-reply textarea');
  check('clicking the row reopens the composer', !!ta);
  check('seeded with the draft', ta && ta.value === 'ab', ta && ta.value);
  check('the row is gone while composing', !find('.md-thread-draft-mark'));
  typeInto(ta, 'ab plus more');
  key('Escape', ta);
  await sleep(60);
  check('Escape closes the composer', !find('.md-thread-reply'));
  check('and the earlier draft survives as its row',
    draftRows().every((r) => r && r.textContent === 'ab'), draftRows().map((r) => r && r.textContent));

  // --- emptying the draft and clicking away deletes it ---
  click(find('.md-thread-draft-mark'));
  await sleep(20);
  typeInto(find('.md-thread-reply textarea'), '   ');
  clickBlock('Third paragraph');
  await sleep(20);
  check('an emptied draft clicked away is gone', !find('.md-thread-draft-mark'));
  check('and the Reply button is back', !!find('.md-thread-card.needs-user .md-thread-actions button'));
  key('Escape');
  await sleep(20);

  // --- Discard destroys ---
  ta = openReply();
  typeInto(ta, 'to be discarded');
  clickBlock('Second paragraph');
  await sleep(20);
  check('draft row after the second click-away', !!find('.md-thread-draft-mark'));
  key('Escape');
  click(find('.md-thread-draft-mark'));
  await sleep(20);
  const discard = Array.from(find('.md-thread-reply').querySelectorAll('button')).find((b) => b.textContent === 'Discard');
  click(discard);
  await sleep(60);
  check('Discard closes the composer', !find('.md-thread-reply'));
  check('and destroys the draft', !find('.md-thread-draft-mark'));

  // --- keys typed in the composer stay its own ---
  ta = openReply();
  key('Escape', document.body);
  await sleep(60);
  check('a page-wide Escape still closes an open reply', !find('.md-thread-reply'));

  viewer.close();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
