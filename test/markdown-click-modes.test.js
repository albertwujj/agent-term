// Click, caret and highlight in the markdown viewer, driving the REAL
// src/markdown-viewer.js in jsdom (design: .git/discussion/md-click-modes.md,
// summarized in docs/dev/maintainer/md-editing-design.md):
//  - the wash marks what a letter comments on: a clicked block, never a
//    selection's block, never an open editor
//  - what's under the pointer picks the state: a word arms the block for a
//    comment; a gap between two words opens the editor with a slot; your own
//    mark reopens the edit at the click
//  - a word typed into a gap gets its own space; closing punctuation joins
//    the word before; Enter at a fresh slot breaks the line
//  - To comment / To edit move typed words between an edit and a comment, and
//    undo each other; To comment shows only while nothing would be dropped
//  - the strip's Revert drops a reopened edit whole
// jsdom has no layout, so the hit-test is stubbed: `aim` names the text spot
// caretRangeFromPoint returns, and every range box contains the click point.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => s };
if (!dom.window.CSS.highlights) dom.window.CSS.highlights = new Map();
if (!dom.window.Highlight) dom.window.Highlight = class { constructor() {} };
const BOX = { width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 };
dom.window.Range.prototype.getClientRects = () => [BOX];
dom.window.Range.prototype.getBoundingClientRect = () => BOX;

let aimed = null;
document.caretRangeFromPoint = () => {
  if (!aimed || !aimed.node.isConnected) return null;
  const r = document.createRange();
  r.setStart(aimed.node, aimed.offset);
  r.collapse(true);
  return r;
};

const { createMarkdownViewer } = require('../src/markdown-viewer');

const FIXTURE = [
  '# Click modes',
  '',
  'The poller reads the file once a second and redraws.',
  '',
  'Second paragraph for the selection round trip.',
  '',
  'Third paragraph kept for strikes.',
  '',
  'Fourth paragraph for the sealed check.',
  '',
  'Fifth paragraph for the revert check.',
].join('\n');

const sentBatches = [];
const store = { version: 1, turn: 1, threads: [] };
const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/modes.md', content: FIXTURE, mtimeMs: 1, size: FIXTURE.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitMarkdownThreads: async ({ threads }) => { sentBatches.push(threads); return { success: true, data: store }; },
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  requestRunbookClone: async () => ({ ok: true }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: false }),
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
const editing = () => primary().querySelector('.md-rendered-editing');
const block = (text) => Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
  .find((b) => b.textContent.includes(text));
const hint = () => (document.querySelector('.md-bar-hint.on') || { textContent: '' }).textContent;
const card = () => document.querySelector('.md-comment-card textarea');
const button = (root, label) => root && Array.from(root.querySelectorAll('button'))
  .find((b) => b.textContent.startsWith(label));
const stripButton = (label) => button(document.querySelector('.md-editing-strip'), label);

// Aim the hit-test at `needle` (+delta chars) inside the block holding `text`.
function aim(text, needle, delta = 0) {
  const el = block(text);
  const walker = document.createTreeWalker(el, 4, null);
  let n;
  while ((n = walker.nextNode())) {
    const i = n.data.indexOf(needle);
    if (i >= 0) { aimed = { node: n, offset: i + delta }; return el; }
  }
  throw new Error(`no "${needle}" in "${text}"`);
}
async function clickAimed(el, target = el) {
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }));
  await sleep(10);
}
function type(el, data) {
  for (const ch of data) {
    el.dispatchEvent(new dom.window.InputEvent('beforeinput', {
      inputType: 'insertText', data: ch, bubbles: true, cancelable: true,
    }));
  }
}
// A beforeinput delete whose target range is the char beside the caret, as
// Chromium hands it over.
function erase(el, backward = true) {
  const s = dom.window.getSelection();
  const r = s.getRangeAt(0).cloneRange();
  const node = r.startContainer;
  const at = r.startOffset;
  const target = backward
    ? { startContainer: node, startOffset: at - 1, endContainer: node, endOffset: at }
    : { startContainer: node, startOffset: at, endContainer: node, endOffset: at + 1 };
  const ev = new dom.window.InputEvent('beforeinput', {
    inputType: backward ? 'deleteContentBackward' : 'deleteContentForward', bubbles: true, cancelable: true,
  });
  ev.getTargetRanges = () => [target];
  el.dispatchEvent(ev);
}
const key = (el, init) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const marks = (el) => el.innerHTML
  .replace(/<del class="md-pending-del">/g, '[').replace(/<\/del>/g, ']')
  .replace(/<ins class="md-pending-ins"[^>]*>/g, '{').replace(/<\/ins>/g, '}')
  .replace(/<[^>]+>/g, '');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

// Esc down the ladder until nothing is open; one Esc past that would roll
// the band up.
async function reset() {
  for (let i = 0; i < 4; i++) {
    if (editing()) key(editing(), { key: 'Escape' });
    else if (card()) key(card(), { key: 'Escape' });
    else if (document.querySelector('.md-bar-hint.on')) key(document, { key: 'Escape' });
    else break;
    await sleep(5);
  }
  aimed = null;
}

async function run() {
  await viewer.open({ filePath: '/fake/modes.md' });
  await sleep(30);

  // --- a word arms the block: the wash, a held caret, the comment hint ---
  {
    const el = aim('The poller', 'reads', 2);
    await clickAimed(el);
    check('a click on a word arms the block, not the editor', !editing() && el.classList.contains('md-comment-target-active'));
    check('the armed caret holds the click spot', !!el.querySelector('.md-edit-caret')
      && el.querySelector('.md-edit-caret').nextSibling.textContent.startsWith('ads'));
    check('the bar says letters comment', hint().startsWith('letters and digits comment'), hint());
    await reset();
  }

  // --- a selection arms without washing its block ---
  {
    const el = block('Second paragraph');
    const node = el.firstChild;
    const r = document.createRange();
    r.setStart(node, node.data.indexOf('selection'));
    r.setEnd(node, node.data.indexOf('selection') + 'selection'.length);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(r);
    el.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(10);
    check('a selection target leaves its block unwashed',
      !el.classList.contains('md-comment-target-active') && !!document.querySelector('.md-bar-hint.on'));
    dom.window.getSelection().removeAllRanges();
    await reset();
  }

  // --- a gap opens the editor with the slot; no wash; editing hint ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const ed = editing();
    check('a click on the space between two words opens the editor', ed === el);
    check('the open editor carries no wash', !el.classList.contains('md-comment-target-active'));
    const slot = el.querySelector('.md-gap-slot');
    check('the slot sits after the gap\'s space', !!slot && /file $/.test(slot.previousSibling.textContent)
      && slot.nextSibling.textContent.startsWith('once'), el.innerHTML);
    check('the native caret hides while the slot shows', el.classList.contains('md-gap-armed'));
    check('the bar says typing edits', hint() === 'typing edits · Esc reverts', hint());
    type(ed, 'only');
    check('a word typed at the gap gets its own space', ed.textContent === 'The poller reads the file only once a second and redraws.', ed.textContent);
    check('the first key closes the slot', !el.querySelector('.md-gap-slot') && !el.classList.contains('md-gap-armed'));
    type(ed, ' ');
    ed.dispatchEvent(new dom.window.Event('blur'));
    await sleep(10);
    const rested = block('The poller');
    check('commit drops a typed trailing space against the gap\'s own',
      rested.textContent === 'The poller reads the file only once a second and redraws.', rested.textContent);
    check('the edit rests with its marks and the bar quiets', !!rested.querySelector('ins.md-pending-ins') && hint() === '', hint());
  }

  // --- your own mark reopens the edit at the click; Revert drops it whole ---
  {
    const el = block('The poller');
    const ins = el.querySelector('ins.md-pending-ins');
    aimed = { node: ins.firstChild, offset: 3 };
    await clickAimed(el, ins);
    const ed = editing();
    check('a click on your insertion reopens the edit there', ed === el && !!el.querySelector('ins.md-pending-ins'));
    type(ed, 'X');
    check('typing extends the insertion at the click', /\{ onXly\}/.test(marks(ed)), marks(ed));
    check('a reopened edit offers no To comment', !!stripButton('To comment') && stripButton('To comment').hidden);
    stripButton('Revert').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    const after = block('The poller');
    check('Revert on a reopened edit drops the whole edit',
      !editing() && !after.querySelector('ins, del') && !document.querySelector('.md-pending-note-mark'), after.innerHTML);
    await reset();
  }

  // --- closing punctuation at a gap joins the word before ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    type(editing(), ',');
    check('a comma at the gap joins the word before', editing().textContent.includes('the file, once'), editing().textContent);
    await reset();
    check('Esc backs the edit out', !editing() && !block('The poller').querySelector('ins'));
  }

  // --- ⌫ at the slot erases into the word before; Delete strikes the space ---
  {
    let el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), true);
    check('backspace at the slot strikes the end of the word before', /fil\[e\] once/.test(marks(editing())), marks(editing()));
    await reset();
    el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), false);
    check('delete at the slot strikes the space, joining the words', /file\[ \]once/.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- Enter at a fresh slot breaks the line; it does not send ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    key(editing(), { key: 'Enter' });
    await sleep(10);
    check('Enter at the slot breaks the line, editor still open',
      !!editing() && !!editing().querySelector('ins.md-pending-break') && sentBatches.length === 0);
    await reset();
  }

  // --- a sealed block takes no edits: a gap click arms it for a comment ---
  {
    const el = aim('Fourth paragraph', ' paragraph');
    el.classList.add('md-sealed');
    await clickAimed(el);
    check('a gap in a sealed block arms it for a comment', !editing() && el.classList.contains('md-comment-target-active'));
    el.classList.remove('md-sealed');
    await reset();
  }

  // --- To comment from a gap, and To edit back: they undo each other ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    check('a fresh gap edit offers To comment with its chord', !!stripButton('To comment') && !stripButton('To comment').hidden
      && /⌘E|Ctrl\+E/.test(stripButton('To comment').textContent));
    type(editing(), 'make this configurable');
    stripButton('To comment').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    const back = block('The poller');
    check('To comment takes the words out of the page into a comment',
      !editing() && !!card() && card().value === 'make this configurable' && !back.querySelector('ins'), card() && card().value);
    check('the comment is on the block: washed, caret back at the gap',
      back.classList.contains('md-comment-target-active') && !!back.querySelector('.md-edit-caret')
      && back.querySelector('.md-edit-caret').nextSibling.textContent.startsWith(' once'));
    button(document.querySelector('.md-comment-card'), 'To edit').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    check('To edit puts the words back as their own word',
      !!editing() && editing().textContent === 'The poller reads the file make this configurable once a second and redraws.',
      editing() && editing().textContent);
    check('and the round trip still offers To comment', !stripButton('To comment').hidden);
    await reset();
  }

  // --- To edit over a selection, To comment back onto the same selection ---
  {
    const el = block('Second paragraph');
    const node = el.firstChild;
    const at = node.data.indexOf('round trip');
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + 'round trip'.length);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(r);
    el.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(10);
    key(document, { key: 'l' });
    await sleep(10);
    card().value = 'loop';
    dom.window.getSelection().removeAllRanges();
    button(document.querySelector('.md-comment-card'), 'To edit').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    check('To edit strikes the selection and types the words over it', /\[round trip\]\{loop\}/.test(marks(editing())), marks(editing()));
    check('typing over the opening selection still converts back', !stripButton('To comment').hidden);
    key(editing(), { key: 'e', metaKey: true });
    await sleep(10);
    const back = block('Second paragraph');
    check('To comment (⌘E) returns the words to a comment on the same selection',
      !editing() && !!card() && card().value === 'loop' && !back.querySelector('ins, del')
      && !back.classList.contains('md-comment-target-active'), card() && card().value);
    card().value = '';
    await reset();
  }

  // --- To comment leaves when converting would drop something ---
  {
    const el = aim('Third paragraph', 'strikes', 3);
    await clickAimed(el);
    key(document, { key: 'Backspace' });
    await sleep(10);
    check('an edit that struck text offers no To comment', !!editing() && stripButton('To comment').hidden);
    await reset();
    const gapEl = aim('Third paragraph', ' kept');
    await clickAimed(gapEl);
    type(editing(), 'w');
    const ta = document.querySelector('.md-editing-strip textarea');
    ta.value = 'why';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    check('an edit with a note offers no To comment', stripButton('To comment').hidden);
    ta.value = '';
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    check('clearing the note brings it back', !stripButton('To comment').hidden);
    await reset();
  }

  // --- the resting note row reopens the edit with the note in hand ---
  {
    const el = aim('Fifth paragraph', ' the');
    await clickAimed(el);
    type(editing(), 'x');
    editing().dispatchEvent(new dom.window.Event('blur'));
    await sleep(10);
    const row = primary().querySelector('.md-pending-note-mark');
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    check('the note row reopens the edit with the note focused',
      editing() === block('Fifth paragraph') && document.activeElement === document.querySelector('.md-editing-strip textarea'));
    stripButton('Revert').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
  }

  // --- the pointer turns amber over a gap only ---
  {
    const layout = document.querySelector('.md-spread-layout');
    const el = aim('The poller', ' once');
    el.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
    await sleep(10);
    check('over a gap the pointer turns amber', layout.classList.contains('md-gap-hover'));
    aim('The poller', 'reads', 2);
    el.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
    await sleep(10);
    check('over a word it is the plain text pointer', !layout.classList.contains('md-gap-hover'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the viewer's poll interval would keep node alive
}

run().catch((e) => { console.error(e); process.exit(1); });
