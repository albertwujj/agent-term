// What the agent writes while the user has work open in the page, driving the
// REAL src/markdown-viewer.js in jsdom.
//
// Any queued comment used to hold every refresh until Send, and nothing said
// so once the band's arrival flash ran out: the agent's edit stayed off the
// page for as long as a comment waited, then landed with a pulse at Send, as
// if the Send had made it. Now a refresh held behind an open composer or reply
// keeps the bar's unseen hue, the one a roll-up shows; queued comments hold it
// only when the agent touched their block; and a Send lands what it held at
// once, rather than a poll later as the agent's answer.

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

const ALPHA = 'Alpha paragraph is the one the agent rewrites first.';
const BRAVO = 'Bravo paragraph takes the comment typed while the agent writes.';
const CHARLIE = 'Charlie paragraph takes the comment left queued.';
const DELTA = 'Delta paragraph is plain.';
let disk = ['# Held refresh', '', ALPHA, '', BRAVO, '', CHARLIE, '', DELTA].join('\n');
let mtime = 1;
function agentWrites(next) {
  disk = next;
  mtime += 1;
}

let store = { version: 1, turn: 0, threads: [] };
const batches = [];
const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: disk, mtimeMs: mtime, size: disk.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: mtime, size: disk.length }),
  submitMarkdownThreads: async (payload) => {
    batches.push(payload);
    const turn = store.turn + 1;
    store = {
      version: 1,
      turn,
      threads: store.threads.concat(payload.threads.map((t, i) => ({
        id: `t-${turn}-${i}`, anchor: t.anchor, anchor_status: 'ok',
        messages: [{ author: 'user', body: t.body, ts: turn, turn }],
      }))),
    };
    return { success: true, data: store };
  },
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', mtimeMs: 1, size: 0 }),
  showToast: noop,
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
const find = (sel) => primary().querySelector(sel);
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (k, init = {}) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: k, ...init }));
const unseenHue = () => document.querySelector('.vb-shell.vb-md').classList.contains('vb-unseen');
const block = (text) => Array.from(primary().querySelectorAll('[data-md-anchor-id]')).find((b) => b.textContent.includes(text));
const shows = (text) => !!block(text);

function clickBlock(text) {
  const el = block(text);
  if (!el) throw new Error(`no block matching ${text}`);
  click(el);
  return el;
}
function typeInto(ta, text) {
  ta.value = text;
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
async function comment(text, body) {
  clickBlock(text);
  key('c');
  await sleep(20);
  const box = find('.md-comment-card textarea');
  typeInto(box, body);
  return box;
}
function sendButton() {
  return Array.from(find('.md-comment-card').querySelectorAll('button')).find((b) => b.textContent.startsWith('Send'));
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(POLL);
  check('a fresh doc has nothing unseen', !unseenHue());

  // An open composer holds the agent's edit, and the bar says so.
  await comment('Bravo paragraph', 'is this the right example?');
  agentWrites(disk.replace(ALPHA, 'Alpha paragraph now reads the way the agent rewrote it.'));
  await sleep(POLL);
  check('an open composer holds the edit', shows(ALPHA) && !shows('the way the agent rewrote it'));
  check('the held edit takes the unseen hue', unseenHue());

  // Send lands it with the receipt, not a poll later.
  click(sendButton());
  await sleep(60);
  check('the comment went out', batches.length === 1 && batches[0].threads.length === 1);
  check('Send lands the held edit at once', shows('the way the agent rewrote it') && !shows(ALPHA));
  check('and pulses the block it changed', !!block('the way the agent rewrote it')?.classList.contains('md-change-pulse'));

  // A queued comment rides an edit that leaves its block whole, even when the
  // edit adds a block above it and every id below shifts.
  await comment('Charlie paragraph', 'tighten this one');
  clickBlock('Delta paragraph'); // click away: the draft queues
  await sleep(20);
  key('Escape');
  await sleep(20);
  check('the comment rests queued', !find('.md-comment-card') && !!find('.md-queued-comment-mark'));
  const charlieIdBefore = block('Charlie paragraph').getAttribute('data-md-anchor-id');
  agentWrites(disk.replace('# Held refresh\n', '# Held refresh\n\nEcho paragraph is new, above the rest.\n'));
  await sleep(POLL);
  check('the edit lands with a comment queued', shows('Echo paragraph is new'));
  check('the block ids below it shifted', block('Charlie paragraph')?.getAttribute('data-md-anchor-id') !== charlieIdBefore);
  const mark = find('.md-queued-comment-mark');
  check('the mark seats back under its own block',
    !!mark && mark.previousElementSibling && mark.previousElementSibling.textContent.includes('Charlie paragraph'),
    mark && mark.previousElementSibling && mark.previousElementSibling.textContent);

  // The agent's reply renders with the comment still queued.
  store = {
    ...store,
    threads: store.threads.map((t) => ({
      ...t, status: 'open',
      messages: [...t.messages, { author: 'agent', body: 'Yes, it is the example to keep.', ts: 9, turn: store.turn }],
    })),
  };
  await sleep(POLL);
  check("the agent's reply shows with a comment queued",
    Array.from(primary().querySelectorAll('.md-thread-card')).some((c) => c.textContent.includes('the example to keep')));
  check('the mark is still there', !!find('.md-queued-comment-mark'));

  // From here, a block on screen counts as seen, so only a held refresh keeps the hue.
  dom.window.Element.prototype.getClientRects = function () {
    return [{ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }];
  };
  for (const article of document.querySelectorAll('.md-viewer-body')) {
    article.parentElement.getBoundingClientRect = () => ({ top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000 });
  }
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  await sleep(20);
  check('changes on screen clear the hue', !unseenHue());

  // An edit to the queued comment's own block stays held until Send.
  agentWrites(disk.replace(CHARLIE, 'Charlie paragraph, rewritten under the queued comment.'));
  await sleep(POLL);
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  await sleep(20);
  check("an edit to the queued comment's block is held", shows(CHARLIE) && !shows('rewritten under the queued comment'));
  check('and keeps the unseen hue while held', unseenHue());
  click(find('.md-queued-comment-mark'));
  await sleep(20);
  check('the draft reopens intact', find('.md-comment-card textarea')?.value === 'tighten this one');
  click(sendButton());
  await sleep(60);
  const last = batches[batches.length - 1];
  check('it sends the text it was written about', last && last.threads[0].anchor.snippet === CHARLIE,
    last && last.threads[0].anchor);
  check('Send lands that edit too', shows('rewritten under the queued comment'));
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  await sleep(20);
  check('once it is on screen the hue clears', !unseenHue());

  // A sent edit seals its block against editing, but the block still takes a
  // comment. With that comment queued, the agent applying the edit writes to
  // the comment's block: the write is held, and so is the store that resolves
  // the edit, or the seal would drop from the old text and the edit would
  // seem to vanish.
  clickBlock('Delta paragraph');
  await sleep(5);
  key('Backspace');
  await sleep(5);
  const editor = find('.md-rendered-editing');
  editor.textContent = 'Delta paragraph, as the user edited it.';
  editor.dispatchEvent(new dom.window.Event('blur'));
  await sleep(10);
  key('Enter', { metaKey: true });
  await sleep(60);
  check('a sent edit seals its block', !!block('Delta')?.classList.contains('md-sealed'));
  await comment('Delta', 'also name the default');
  clickBlock('Alpha');
  await sleep(20);
  key('Escape');
  await sleep(20);
  check('the sealed block takes a queued comment', !!find('.md-queued-comment-mark'));
  const edit = store.threads[store.threads.length - 1];
  agentWrites(disk.replace(DELTA, 'Delta paragraph, as the user edited it.'));
  store = {
    ...store,
    threads: store.threads.map((t) => (t.id === edit.id
      ? { ...t, status: 'resolved', messages: [...t.messages, { author: 'agent', body: 'Applied.', ts: mtime, turn: store.turn }] }
      : t)),
  };
  await sleep(POLL);
  check('the edit stays sealed while a comment on it waits', !!block('Delta')?.classList.contains('md-sealed'),
    block('Delta')?.className);
  check('the held write keeps the unseen hue', unseenHue());
  click(find('.md-queued-comment-mark'));
  await sleep(20);
  click(sendButton());
  await sleep(60);
  check('Send lands the applied edit, unsealed',
    !!block('as the user edited it') && !block('Delta').classList.contains('md-sealed'), block('Delta')?.className);

  viewer.close();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
