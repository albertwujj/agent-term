// Opening and folding thread rows, driving the REAL src/markdown-viewer.js in
// jsdom through the actual gestures (click a block → click a row → click the
// card).
//
// This exists because expanding a row mutated state.expandedThreads and then
// asked layoutSpread to draw it — and layoutSpread refuses to rebuild while a
// block is armed. Any plain click in the text arms a block, and a row's click
// stops propagation before it can reach the handler that disarms one, so after
// the first click anywhere in the doc every click on a comment row read as
// dead: the set grew, nothing redrew, and the expansion surfaced minutes later
// on an unrelated render. The same veto silently dropped store polls, so an
// agent reply landing while a block was armed was lost for good.

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
// The stub keeps its ranges, so a test can ask what the page reads back.
if (!dom.window.Highlight) dom.window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
  || (() => [{ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }]);
dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
  || (() => ({ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }));

const { createMarkdownViewer } = require('../src/markdown-viewer');

const FIXTURE = [
  '# Heading Words Here',
  '',
  'First paragraph carries the resolved thread.',
  '',
  'Second paragraph carries the thread awaiting the agent.',
  '',
  'Third paragraph is plain text with nothing attached to it.',
  '',
  'Fourth paragraph carries three resolved threads, one of them an edit.',
].join('\n');

// A resolved thread (rests as a line, click opens the card) and one still
// awaiting the agent (the other row shape).
const store = {
  version: 1,
  turn: 2,
  threads: [
    {
      id: 't-resolved',
      anchor: { snippet: 'First paragraph carries the resolved thread.' },
      anchor_status: 'ok',
      status: 'resolved',
      messages: [
        { author: 'user', body: 'Is the first one right?', ts: 1, turn: 1 },
        { author: 'agent', body: 'Fixed.', ts: 2, turn: 2 },
      ],
    },
    {
      id: 't-waiting',
      anchor: { snippet: 'Second paragraph carries the thread awaiting the agent.' },
      anchor_status: 'ok',
      status: 'open',
      messages: [{ author: 'user', body: 'Take a look at the second one.', ts: 3, turn: 2 }],
    },
    // Three resolved on one block, stored out of time order (a re-anchor can
    // do that): newest by first message wins the top, not store position.
    {
      id: 'r-old',
      anchor: { snippet: 'three resolved threads' },
      anchor_status: 'ok',
      status: 'resolved',
      messages: [
        { author: 'user', body: 'Oldest ask on the fourth.', ts: 10, turn: 1 },
        { author: 'agent', body: 'Done, oldest.', ts: 11, turn: 2 },
      ],
    },
    {
      id: 'r-new',
      // An edit the agent re-anchored to the sentence it was about: a
      // selection, so opening its card reads that text back.
      anchor: { snippet: 'one of them an edit' },
      anchor_status: 'ok',
      status: 'resolved',
      messages: [
        { author: 'user', body: '[Edit] Fourth paragraph carries three resolved threads, one of them <del>an edit</del><ins>a change</ins>. [/Edit]', ts: 50, turn: 3 },
        { author: 'agent', body: 'Kept as it was.', ts: 51, turn: 4 },
      ],
    },
    {
      id: 'r-mid',
      // An edit still anchored to its whole block: a locator, no readback.
      anchor: { snippet: 'Fourth paragraph carries three resolved threads, one of them an edit.' },
      anchor_status: 'ok',
      status: 'resolved',
      messages: [
        { author: 'user', body: '[Edit] Fourth paragraph <del>carries</del><ins>holds</ins> three resolved threads, one of them an edit. [/Edit]', ts: 30, turn: 2 },
        { author: 'agent', body: 'Applied, middle.', ts: 31, turn: 3 },
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
const primary = () => document.querySelectorAll('.md-viewer-body')[0];
const find = (sel) => primary().querySelector(sel);
const armed = () => !!find('.md-comment-target-active');
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// A missing row/card is the failure this file is about, so clicking one that
// isn't there reports and moves on instead of taking the run down with it.
const clickSel = (sel) => {
  const el = find(sel);
  if (!el) { console.log(`  (nothing matching ${sel} to click)`); return false; }
  click(el);
  return true;
};

function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes(matchText));
  if (!el) throw new Error(`no block matching ${matchText}`);
  click(el);
  return el;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(40);

  check('a resolved thread rests as a line', !!find('.md-thread-resolved-line'));
  check('a thread awaiting the agent rests as a line', !!find('.md-thread-waiting-line'));

  // --- the plain case: nothing armed ---
  clickSel('.md-thread-resolved-line');
  await sleep(20);
  check('clicking the line opens the card', !!find('.md-thread-card.resolved'));
  clickSel('.md-thread-card.resolved');
  await sleep(20);
  check('clicking the card folds it back', !find('.md-thread-card.resolved') && !!find('.md-thread-resolved-line'));

  // --- the armed case: a plain click in the text arms the block under it ---
  clickBlock('Third paragraph');
  await sleep(20);
  check('a plain click arms the block', armed());

  clickSel('.md-thread-resolved-line');
  await sleep(20);
  check('the line still opens with a block armed', !!find('.md-thread-card.resolved'));
  check('and opening it disarms the block', !armed());

  clickSel('.md-thread-card.resolved');
  await sleep(20);
  check('the card still folds with a block armed', !find('.md-thread-card.resolved'));

  clickBlock('Third paragraph');
  await sleep(20);
  clickSel('.md-thread-waiting-line');
  await sleep(20);
  check('the waiting line opens with a block armed', !!find('.md-thread-card.waiting'));
  clickSel('.md-thread-card.waiting');
  await sleep(20);
  check('and folds back to its line', !!find('.md-thread-waiting-line'));

  // --- a store update arriving while a block is armed ---
  // layoutSpread refuses to rebuild under an armed block, so the render has to
  // come back as pending: the store signature is recorded on read, and no later
  // poll asks for it again.
  clickBlock('Third paragraph');
  await sleep(20);
  store.threads[1].messages.push({ author: 'agent', body: 'Which half?', ts: 4, turn: 3 });
  await sleep(1400); // one poll tick
  check('the agent reply is held while the block is armed', !find('.md-thread-card.needs-user'));
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await sleep(1400); // the next tick flushes what was held
  check('and lands once the block is disarmed', !!find('.md-thread-card.needs-user'));

  // --- a block's resolved history: newest first, folded to the newest ---
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await sleep(20);
  const fourth = () => Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes('Fourth paragraph'));
  const rows = () => {
    const out = [];
    for (let el = fourth().nextElementSibling; el && el.classList.contains('md-resolved-item'); el = el.nextElementSibling) out.push(el);
    return out;
  };
  const shape = () => rows().map((el) => (el.classList.contains('md-thread-card') ? 'card' : 'line'));
  const hooks = () => rows().map((el) => el.querySelector('.md-anno-text').textContent);
  const caret = () => { const c = rows()[0] && rows()[0].querySelector('.md-resolved-caret'); return c ? c.textContent : null; };
  const tail = () => { const m = rows()[0] && rows()[0].querySelector('.md-resolved-more'); return m ? m.textContent : null; };
  // What the thread readback highlights, as text. Another card on the page
  // (the second paragraph's, blocked on the user) keeps its own readback up
  // throughout, so ask for the fourth's text rather than for any highlight.
  const readback = () => {
    const h = dom.window.CSS.highlights.get('md-thread-anchor');
    return h ? h.ranges.map((r) => String(r)) : [];
  };
  const highlighted = (text) => readback().some((s) => s.includes(text));

  check('folded: the newest thread alone, as its line', shape().join() === 'line', shape());
  check('the folded line is the newest by first message, not store order', /Kept as it was/.test(hooks()[0]), hooks());
  check('the count of the rest is its tail', tail() === '+2 more', tail());
  check('and a gutter caret says it unfolds', caret() === '▸', caret());

  click(rows()[0]);
  await sleep(20);
  check('clicking the folded line opens that thread without unfolding the rest', shape().join() === 'card' && /Kept as it was/.test(rows()[0].textContent), shape());
  check('the caret stays on the card', caret() === '▸', caret());
  check('an edit re-anchored to a sentence reads it back', highlighted('one of them an edit'), readback());

  click(rows()[0]);
  await sleep(20);
  check('clicking the card folds it back to the line', shape().join() === 'line' && tail() === '+2 more', shape());
  check('and the readback clears', !highlighted('one of them an edit'), readback());

  click(rows()[0].querySelector('.md-resolved-more'));
  await sleep(20);
  check('the tail unfolds to a line per thread, newest first', shape().join() === 'line,line,line'
    && /Kept as it was/.test(hooks()[0]) && /middle/.test(hooks()[1]) && /oldest/.test(hooks()[2]), hooks());
  check('unfolded: the caret flips and the tail goes', caret() === '▾' && tail() === null, [caret(), tail()]);

  click(rows()[1]);
  await sleep(20);
  check('a line below opens in place', shape().join() === 'line,card,line', shape());
  check('an edit anchored to its whole block reads nothing back', !highlighted('Fourth paragraph'), readback());
  click(rows()[1]);
  await sleep(20);
  click(rows()[0]);
  await sleep(20);
  check('the newest opens at the top of the unfolded list', shape().join() === 'card,line,line', shape());

  click(rows()[0].querySelector('.md-resolved-caret'));
  await sleep(20);
  check('folding keeps the newest card open and hides the rest', shape().join() === 'card' && caret() === '▸', shape());
  click(rows()[0]);
  await sleep(20);
  check('the card folds to the line with its tail', shape().join() === 'line' && tail() === '+2 more', [shape(), tail()]);

  viewer.close();
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
