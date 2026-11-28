// Click, caret and highlight in the markdown viewer, driving the REAL
// src/markdown-viewer.js in jsdom (design: .git/discussion/md-click-modes.md,
// summarized in docs/dev/maintainer/md-editing-design.md):
//  - the wash marks what a letter comments on: a clicked block, never a
//    selection's block, never an open editor
//  - what's under the pointer picks the state: a word arms the block for a
//    comment; a gap between two words opens the editor with a block caret on
//    the space, inserting nothing; your own
//    mark reopens the edit at the click
//  - a word typed into a gap gets its own space; closing punctuation joins
//    the word before; Enter at a fresh gap caret breaks the line
//  - a clicked block holds no caret: every typed character comments on it
//  - To edit (selections only) and To comment move typed words between an
//    edit and a comment; To comment shows only while nothing would be dropped
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
  '',
  '```',
  'total = add(first, second)',
  '```',
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
// A beforeinput delete whose target range is the char beside the caret (or
// the selection), as Chromium hands it over: across text nodes, since each
// typed key is a node of its own.
function erase(el, backward = true) {
  const s = dom.window.getSelection();
  const r = s.getRangeAt(0).cloneRange();
  let target = r;
  if (r.collapsed) {
    const nodes = [];
    const w = document.createTreeWalker(el, 4, null);
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    const at = pre.toString().length;
    const point = (k, isEnd) => {
      let left = k;
      for (const t of nodes) {
        if (left < t.data.length || (isEnd && left === t.data.length)) return [t, left];
        left -= t.data.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.data.length];
    };
    const [from, to] = backward ? [Math.max(0, at - 1), at] : [at, at + 1];
    const [sc, so] = point(from, false);
    const [ec, eo] = point(to, true);
    target = { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo };
  }
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

  // --- a word arms the block for a comment: the yellow, no caret ---
  {
    const el = aim('The poller', 'reads', 2);
    await clickAimed(el);
    check('a click on a word arms the block, not the editor', !editing() && el.classList.contains('md-comment-target-active'));
    check('an armed block holds no caret', !el.querySelector('span'), el.innerHTML);
    check('the bar says typing comments', hint() === 'type to comment', hint());
    key(document, { key: 'Backspace' });
    await sleep(10);
    check('⌫ on an armed block opens no edit', !editing() && !card());
    key(document, { key: '(' });
    await sleep(10);
    check('punctuation opens the comment too: there is no caret to edit at', !!card() && card().value === '(');
    check('a whole-block comment offers no To edit', !button(document.querySelector('.md-comment-card'), 'To edit'));
    card().value = '';
    await reset();
  }

  // --- a selection covers whole words: mid-word ends grow, spaces fall away.
  //     (jsdom drops the live selection when the band takes focus, so this
  //     reads what the comment quotes.) ---
  {
    const quoteOf = async (needleFrom, fromDelta, needleTo, toDelta, inBlock = 'Second paragraph') => {
      const el = block(inBlock);
      const w = document.createTreeWalker(el, 4, null);
      let node = w.nextNode();
      while (node && !node.data.includes(needleFrom)) node = w.nextNode();
      const r = document.createRange();
      r.setStart(node, node.data.indexOf(needleFrom) + fromDelta);
      r.setEnd(node, node.data.indexOf(needleTo) + toDelta);
      dom.window.getSelection().removeAllRanges();
      dom.window.getSelection().addRange(r);
      el.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
      await sleep(10);
      key(document, { key: 'q' });
      await sleep(10);
      const before = sentBatches.length;
      card().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
      await sleep(30);
      const sent = sentBatches.length > before ? sentBatches[sentBatches.length - 1] : [];
      await reset();
      return sent.length ? sent[sent.length - 1].anchor.snippet : null;
    };
    const midWords = await quoteOf('round trip', 1, 'trip.', 3); // r|ound ... tri|p
    check('a selection from mid-word to mid-word quotes the whole words', midWords === 'round trip', midWords);
    const spaced = await quoteOf(' selection', 0, ' round', 0); // " selection" with its leading space
    check('spaces at a selection\'s ends fall away', spaced === 'selection', spaced);
    const code = await quoteOf('total', 2, 'second', 3, 'total = add');
    check('in a code block a selection covers whole words too', code === 'total = add(first, second', code);
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

  // --- a gap opens the editor with the block caret; no wash; editing hint ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const ed = editing();
    check('a click on the space between two words opens the editor', ed === el);
    check('the open editor carries no wash', !el.classList.contains('md-comment-target-active'));
    const sel = dom.window.getSelection();
    const r = sel.getRangeAt(0);
    check('the gap caret waits just before the space, inserting nothing',
      r.collapsed && r.startContainer.data.slice(r.startOffset).startsWith(' once')
      && el.textContent === 'The poller reads the file once a second and redraws.' && el.children.length === 0,
      el.innerHTML);
    check('the caret is drawn as a block over the space', el.classList.contains('md-gap-caret'));
    check('the bar says typing edits', hint() === 'typing edits · Esc reverts', hint());
    type(ed, 'only');
    check('a word typed at the gap gets its own space', ed.textContent === 'The poller reads the file only once a second and redraws.', ed.textContent);
    check('the first key returns the bar caret', !el.classList.contains('md-gap-caret'));
    type(ed, ' ');
    ed.dispatchEvent(new dom.window.Event('blur'));
    await sleep(10);
    const rested = block('The poller');
    check('commit drops a typed trailing space against the gap\'s own',
      rested.textContent === 'The poller reads the file only once a second and redraws.', rested.textContent);
    check('the edit rests with its marks and the bar quiets', !!rested.querySelector('ins.md-pending-ins') && hint() === '', hint());
  }

  // --- the near half of the letter beside a space counts as the gap too ---
  {
    const after = aim('Fourth paragraph', 'for', 0); // caret lands just after the space
    await clickAimed(after);
    const r = dom.window.getSelection().getRangeAt(0);
    check('a click on the edge of the word after a space opens the editor at the gap',
      editing() === after && after.classList.contains('md-gap-caret')
      && r.startContainer.data.slice(r.startOffset).startsWith(' for'));
    await reset();
    const before = aim('Fourth paragraph', 'paragraph', 9); // caret lands just before the space
    await clickAimed(before);
    check('so does a click on the edge of the word before it', editing() === before && before.classList.contains('md-gap-caret'));
    await reset();
    const own = block('The poller');
    aim('The poller', 'file', 4); // the space after "file" is the user's own insertion
    await clickAimed(own);
    check('a space inside your own insertion is your mark, not a gap', !editing() || !own.classList.contains('md-gap-caret'));
    await reset();
  }

  // --- a double-click still selects a word for a comment ---
  {
    const el = aim('Fourth paragraph', 'sealed', 0);
    await clickAimed(el);
    const ed = editing();
    const node = Array.from(ed.childNodes).find((n) => n.nodeType === 3 && n.data.includes('sealed'));
    const word = document.createRange();
    word.setStart(node, node.data.indexOf('sealed'));
    word.setEnd(node, node.data.indexOf('sealed') + 'sealed'.length);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(word);
    ed.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await sleep(10);
    check('a double-click in an untouched gap editor ends it and arms the word',
      !editing() && hint().startsWith('letters and digits comment')
      && !block('Fourth paragraph').classList.contains('md-comment-target-active'), hint());
    key(document, { key: 'k' });
    await sleep(10);
    check('so a letter then comments on that word', !!card() && card().value === 'k');
    card().value = '';
    await reset();
    const again = aim('Fourth paragraph', 'sealed', 0);
    await clickAimed(again);
    type(editing(), 'x');
    editing().dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await sleep(10);
    check('once something is typed, a double-click stays in the edit', !!editing());
    await reset();
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
    check('a click in your own text puts the caret where you clicked: typing goes on there', /\{ onXly\} once/.test(marks(ed)), marks(ed));
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

  // --- ⌫ and Delete take a word: ⌫ at the gap strikes the word before,
  //     Delete the space and word after ---
  {
    let el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), true);
    check('backspace at the gap strikes the word before', /the \[file\] once/.test(marks(editing())), marks(editing()));
    erase(editing(), true);
    check('pressing on strikes the next word, one strike with the space between', /reads \[the file\] once/.test(marks(editing())), marks(editing()));
    await reset();
    el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), false);
    check('delete at the gap strikes the next word with its space', /file\[ once\] a/.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- your own text goes a letter at a time, a struck word comes back
  //     whole, your part of a word goes first ---
  {
    let el = aim('The poller', ' once');
    await clickAimed(el);
    type(editing(), 'only now');
    erase(editing(), true);
    check('⌫ takes back the last letter you typed', /file\{ only no\} once/.test(marks(editing())), marks(editing()));
    for (let i = 0; i < 7; i++) erase(editing(), true);
    check('taking back your first letter takes the gap\'s space with it',
      !editing().querySelector('ins') && editing().textContent.includes('the file once'), marks(editing()));
    check('the caret is a gap caret again, so a new word gets its own space', editing().classList.contains('md-gap-caret'));
    type(editing(), 'twice');
    check('a word typed there reads as its own word', /file\{ twice\} once/.test(marks(editing())), marks(editing()));
    await reset();

    el = aim('The poller', ' once');
    await clickAimed(el);
    type(editing(), ',');
    erase(editing(), true);
    check('your part of a word goes first: a typed comma leaves, the word stays',
      !editing().querySelector('ins, del') && editing().textContent.includes('the file once'), marks(editing()));
    await reset();

    el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), true); // strikes "file"
    erase(editing(), false); // Delete from just before the strike: the struck word comes back
    check('Delete over a struck word brings it back whole', !editing().querySelector('del') && editing().textContent.includes('the file once'), marks(editing()));
    await reset();
  }

  // --- taking back both struck words brings back the space struck between them ---
  {
    const caretAfter = (needle) => {
      const w = document.createTreeWalker(editing(), 4, null);
      let n;
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + needle.length);
        dom.window.getSelection().removeAllRanges();
        dom.window.getSelection().addRange(r);
        return;
      }
      throw new Error(`no ${needle}`);
    };
    for (const [first, second] of [['file', 'the'], ['the', 'file']]) {
      const el = aim('The poller', ' once');
      await clickAimed(el);
      erase(editing(), true);
      erase(editing(), true);
      check('two ⌫ strike "the file" as one strike', /reads \[the file\] once/.test(marks(editing())), marks(editing()));
      caretAfter(first);
      erase(editing(), true);
      caretAfter(second);
      erase(editing(), true);
      check(`taking back "${first}" then "${second}" leaves no struck space`,
        !editing().querySelector('del') && editing().textContent.includes('reads the file once'), marks(editing()));
      await reset();
    }
  }

  // --- held ⌫ takes a word at a reading pace, not at key-repeat speed ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const held = () => {
      editing().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Backspace', repeat: true }));
      erase(editing(), true);
    };
    editing().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Backspace' }));
    erase(editing(), true);
    held();
    held();
    check('repeats within the hold interval take nothing more', /the \[file\] once/.test(marks(editing())), marks(editing()));
    await sleep(170);
    held();
    check('the next repeat after the interval takes the next word', /reads \[the file\] once/.test(marks(editing())), marks(editing()));
    editing().dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'Backspace' }));
    editing().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
    await reset();
  }

  // --- held ⌫ takes back your words and stops where they end ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    type(editing(), 'very old');
    const press = (repeat) => {
      editing().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Backspace', repeat }));
      erase(editing(), true);
    };
    press(false);
    for (let i = 0; i < 7; i++) press(true); // your letters go at key-repeat speed
    check('held, ⌫ takes back your text a letter per repeat', !editing().querySelector('ins'), marks(editing()));
    await sleep(170);
    press(true);
    check('held, ⌫ takes back your text and stops at the page\'s text',
      !editing().querySelector('ins, del') && editing().textContent.includes('the file once'), marks(editing()));
    await sleep(170);
    press(false);
    check('the next press strikes on', /the \[file\] once/.test(marks(editing())), marks(editing()));
    editing().dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
    await reset();
  }

  // --- every resting caret is the block: typing there makes a new word, a
  //     space added on whichever side lacks one; the bar shows only while
  //     you type ---
  {
    let el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), true); // strikes "file": the caret rests on the space before it
    check('after a strike the caret rests as the block', editing().classList.contains('md-gap-caret'));
    const rest = dom.window.getSelection().getRangeAt(0);
    check('on the space before the struck word, not on its first letter',
      rest.startContainer.data.slice(0, rest.startOffset).endsWith('the') && rest.startContainer.data[rest.startOffset] === ' ',
      rest.startContainer.data.slice(rest.startOffset));
    type(editing(), 'x');
    check('typing there makes a new word with its own space',
      /the\{ x\} \[file\] once/.test(marks(editing())), marks(editing()));
    check('while you type, the caret is the bar', !editing().classList.contains('md-gap-caret'));
    type(editing(), 'y');
    check('and the next key extends your word', /the\{ xy\} \[file\] once/.test(marks(editing())), marks(editing()));
    erase(editing(), true);
    check('⌫ takes back your last letter, the caret the bar', /the\{ x\} \[file\] once/.test(marks(editing())) && !editing().classList.contains('md-gap-caret'), marks(editing()));
    erase(editing(), true);
    check('your first letter goes with the space it brought, and the block returns',
      /the \[file\] once/.test(marks(editing())) && !editing().querySelector('ins') && editing().classList.contains('md-gap-caret'), marks(editing()));
    await reset();

    el = aim('The poller', ' once');
    await clickAimed(el);
    for (let i = 0; i < 6; i++) key(editing(), { key: 'ArrowLeft' });
    type(editing(), 'So');
    check('at the block\'s start a new word gets a space after it', /^\{So \}The poller/.test(marks(editing())), marks(editing()));
    await reset();

    el = aim('The poller', ' once');
    await clickAimed(el);
    erase(editing(), true);
    const sentBefore = sentBatches.length;
    key(editing(), { key: 'Enter' });
    await sleep(30);
    check('once something is done, Enter at the block caret sends', !editing() && sentBatches.length === sentBefore + 1);
    await reset();
  }

  // --- undo and redo: a typed word is one step, and so is a word of your
  //     text erased; undo walks all the way back to where the edit opened ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const typeKeys = async (text) => { for (const ch of text) { type(editing(), ch); await sleep(0); } };
    await typeKeys('only now');
    for (let i = 0; i < 3; i++) { erase(editing(), true); await sleep(0); } // takes back "now", a letter a press
    await typeKeys('then');
    await sleep(0);
    check('the edit reads as typed', /file\{ only then\} once/.test(marks(editing())), marks(editing()));
    const undo = async (shiftKey = false) => { key(editing(), { key: shiftKey ? 'Z' : 'z', metaKey: true, shiftKey }); await sleep(0); };
    await undo();
    check('⌘Z takes back the last word typed', /file\{ only \} once/.test(marks(editing())), marks(editing()));
    await undo();
    check('the next ⌘Z brings back the erased word, its letters one step', /file\{ only now\} once/.test(marks(editing())), marks(editing()));
    await undo();
    check('the next takes back the word before it, a word a step', /file\{ only \} once/.test(marks(editing())), marks(editing()));
    await undo();
    check('and the next takes back the first word, back to where the edit opened',
      !editing().querySelector('ins, del') && editing().textContent.includes('the file once'), marks(editing()));
    await undo(true);
    await undo(true);
    await undo(true);
    await undo(true);
    check('⇧⌘Z redoes each step again', /file\{ only then\} once/.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- arrows move a word at a time; the caret rests between words ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    key(editing(), { key: 'ArrowLeft' });
    check('← moves the caret to the end of the word before, a gap caret', editing().classList.contains('md-gap-caret'));
    type(editing(), 'x');
    check('a word typed there sits between the two words', /the\{ x\} file once/.test(marks(editing())), marks(editing()));
    key(editing(), { key: 'ArrowRight' });
    type(editing(), 'y');
    check('→ moves a word at a time', /file\{ y\} once/.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- a click on a word inside the open edit rests the caret after it ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    aim('The poller', 'poller', 2);
    // The browser puts the caret at the press; the click then settles it.
    const at = document.createRange();
    at.setStart(aimed.node, aimed.offset);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(at);
    await clickAimed(editing());
    type(editing(), 'z');
    check('a mid-word click puts the caret after the word', /poller\{ z\} reads/.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- a page word's letters end before its punctuation: the caret stops
  //     there, so a word goes in before a full stop, and ⌫ there strikes the
  //     letters alone ---
  {
    const clickIn = async (needle, delta) => {
      aim('The poller', needle, delta);
      const at = document.createRange();
      at.setStart(aimed.node, aimed.offset);
      dom.window.getSelection().removeAllRanges();
      dom.window.getSelection().addRange(at);
      await clickAimed(editing());
    };
    let el = aim('The poller', ' once');
    await clickAimed(el);
    await clickIn('redraws', 3);
    type(editing(), 'fast');
    check('a click on a word before a full stop puts the caret before the stop', /redraws\{ fast\}\./.test(marks(editing())), marks(editing()));
    await reset();
    el = aim('The poller', ' once');
    await clickAimed(el);
    await clickIn('redraws', 3);
    erase(editing(), true);
    check('⌫ there strikes the word and keeps the stop', /and \[redraws\]\./.test(marks(editing())), marks(editing()));
    await reset();
  }

  // --- through your own text the arrows are the browser's, a letter at a time ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    type(editing(), 'xy');
    check('← beside your text is the browser\'s', key(editing(), { key: 'ArrowLeft' }));
    await reset();
  }

  // --- a selection inside the open edit covers whole words ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const node = Array.from(editing().childNodes).find((n) => n.nodeType === 3 && n.data.includes('second'));
    const r = document.createRange();
    r.setStart(node, node.data.indexOf('econd'));
    r.setEnd(node, node.data.indexOf('nd redraws') + 1);
    dom.window.getSelection().removeAllRanges();
    dom.window.getSelection().addRange(r);
    editing().dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(10);
    check('a drag inside the edit snaps to whole words', String(dom.window.getSelection()) === 'second and', String(dom.window.getSelection()));
    check('and stays the edit\'s own selection, not a comment target', !!editing() && hint().startsWith('typing edits'), hint());
    erase(editing(), true);
    check('⌫ strikes the snapped words', /\[second and\]/.test(marks(editing())), marks(editing()));
    dom.window.getSelection().removeAllRanges();
    await reset();
  }

  // --- Enter at a fresh gap caret breaks the line; it does not send ---
  {
    const el = aim('The poller', ' once');
    await clickAimed(el);
    const sentBefore = sentBatches.length;
    key(editing(), { key: 'Enter' });
    await sleep(10);
    check('Enter at the gap breaks the line, editor still open',
      !!editing() && !!editing().querySelector('ins.md-pending-break') && sentBatches.length === sentBefore);
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

  // --- To comment from a gap: the words become a comment on the block ---
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
    check('the comment is on the block, which wears the comment yellow',
      back.classList.contains('md-comment-target-active') && !back.querySelector('span'));
    card().value = '';
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
    check('To edit strikes the selection and types the words after it, as their own word', /\[round trip\]\{ loop\}\./.test(marks(editing())), marks(editing()));
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
    const el = aim('Third paragraph', ' kept');
    await clickAimed(el);
    erase(editing(), true); // strikes the "h" of "paragraph"
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

  // --- the end of a block is a gap too: a word typed there gets its space ---
  {
    const el = aim('Fifth paragraph', 'check.', 6); // just after the final "."
    await clickAimed(el);
    check('a click after a block\'s last word opens the editor there', editing() === el && el.classList.contains('md-gap-caret'));
    type(editing(), 'Done');
    check('a word typed at the end gets its own space',
      editing().textContent === 'Fifth paragraph for the revert check. Done', editing().textContent);
    await reset();
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
