// Every Send is a Send all, and a Send is the one thing that shrinks the band,
// driving the REAL src/markdown-viewer.js in jsdom.
//
// A reply's Send used to carry only the reply: comments and edits waiting in
// the page stayed behind, though the comment composer's Send flushed them.
// Now a reply typed while work waits says Send all and takes it along, in one
// batch and one turn. Either way the Send recedes a full band to golden, the
// receipt, and the band returns to full once the agent has answered and the
// CLI says its turn is over (viewer-band.js; the decision is unit-tested in
// viewer-band.test.js, the wiring from the store here).

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
const { setAgentIdle } = require('../src/viewer-band');

const FIXTURE = [
  '# Heading Words Here',
  '',
  'First paragraph carries the thread blocked on the user.',
  '',
  'Second paragraph is plain text with nothing attached to it.',
  '',
  'Third paragraph is also plain text.',
].join('\n');

const blocked = {
  id: 't-needs',
  anchor: { snippet: 'First paragraph carries the thread blocked on the user.' },
  anchor_status: 'ok',
  status: 'open',
  messages: [
    { author: 'user', body: 'Is the first one right?', ts: 1, turn: 1 },
    { author: 'agent', body: 'Which half do you mean?', ts: 2, turn: 2 },
  ],
};
let store = { version: 1, turn: 2, threads: [blocked] };

const calls = { batches: [], replies: [] };
const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: FIXTURE, mtimeMs: 1, size: FIXTURE.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitMarkdownThreads: async (payload) => {
    calls.batches.push(payload);
    const turn = store.turn + 1;
    const threads = store.threads.map((t) => {
      const f = (payload.followUps || []).find((x) => x.threadId === t.id);
      return f ? { ...t, messages: [...t.messages, { author: 'user', body: f.body, ts: 3, turn }] } : t;
    });
    payload.threads.forEach((t, i) => threads.push({
      id: `t-new-${i}`, anchor: t.anchor, anchor_status: 'ok',
      messages: [{ author: 'user', body: t.body, ts: 3, turn }],
    }));
    store = { version: 1, turn, threads };
    return { success: true, data: store };
  },
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async (payload) => { calls.replies.push(payload); return { success: true, data: store }; },
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
const key = (k, target = document) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: k }));
const shell = () => document.querySelector('.vb-shell.vb-md');
const isFull = () => shell().classList.contains('open') && shell().classList.contains('vb-full');
const isGolden = () => shell().classList.contains('open') && !shell().classList.contains('vb-full');

function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes(matchText));
  if (!el) throw new Error(`no block matching ${matchText}`);
  click(el);
  return el;
}
function typeInto(ta, text) {
  ta.value = text;
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
function replyButton(label) {
  return Array.from(find('.md-thread-reply').querySelectorAll('button')).find((b) => b.textContent.startsWith(label));
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  setAgentIdle(true);
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(40);
  check('a doc opens at full', isFull());

  // Queue a comment: click a block, type, click away.
  clickBlock('Second paragraph');
  key('p');
  await sleep(20);
  const commentBox = find('.md-comment-card textarea');
  check('typing on the armed block opens the comment bubble', !!commentBox);
  typeInto(commentBox, 'please tighten this');
  clickBlock('Third paragraph');
  await sleep(20);
  key('Escape');
  await sleep(20);
  check('the comment rests queued', !find('.md-comment-card textarea'));

  // A reply typed while that waits is a Send all.
  click(Array.from(find('.md-thread-card.needs-user').querySelectorAll('button')).find((b) => b.textContent === 'Reply'));
  await sleep(20);
  const replyBox = find('.md-thread-reply textarea');
  check('Reply opens the composer', !!replyBox);
  check('its Send counts what goes with it', !!replyButton('Send all (2)'),
    Array.from(find('.md-thread-reply').querySelectorAll('button')).map((b) => b.textContent));
  typeInto(replyBox, 'the second half');
  click(replyButton('Send all'));
  await sleep(60);
  check('one batch went out', calls.batches.length === 1, calls.batches.length);
  check('carrying the queued comment', calls.batches[0] && calls.batches[0].threads.length === 1);
  check('and the reply as a follow-up', calls.batches[0]
    && JSON.stringify(calls.batches[0].followUps) === JSON.stringify([{ threadId: 't-needs', body: 'the second half' }]),
    calls.batches[0] && calls.batches[0].followUps);
  check('not a separate reply send', calls.replies.length === 0);
  check('the composer closed', !find('.md-thread-reply'));
  check('the Send receded the band to golden', isGolden());

  // The agent answers both: the thread it was blocked on resolved, a reply on
  // the new comment. The CLI still works, so golden holds; once it is idle,
  // full comes back.
  setAgentIdle(false);
  store = {
    version: 1,
    turn: store.turn,
    threads: store.threads.map((t) => (t.id === 't-needs'
      ? { ...t, status: 'resolved', messages: [...t.messages, { author: 'agent', body: 'Done.', ts: 4, turn: store.turn }] }
      : { ...t, messages: [...t.messages, { author: 'agent', body: 'Which word?', ts: 4, turn: store.turn }] })),
  };
  await sleep(1300); // the store poll
  check('answered while the CLI works keeps golden', isGolden());
  setAgentIdle(true);
  check('answered and idle returns to full', isFull());

  // A reply with nothing waiting is a plain Send, and still the receipt.
  shell().querySelector('.vb-bar').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  shell().querySelector('.vb-bar').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  check('back at full by hand', isFull());
  click(Array.from(find('.md-thread-card.needs-user').querySelectorAll('button')).find((b) => b.textContent === 'Reply'));
  await sleep(20);
  check('with nothing waiting it is a plain Send', !!replyButton('Send') && !replyButton('Send all'));
  typeInto(find('.md-thread-reply textarea'), 'the verb');
  click(replyButton('Send'));
  await sleep(60);
  check('a plain reply goes as a reply', calls.replies.length === 1 && calls.batches.length === 1);
  check('and recedes the band too', isGolden());

  viewer.close();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
