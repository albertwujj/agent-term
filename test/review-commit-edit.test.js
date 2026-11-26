// Guards the review viewer's commit-message editing end to end, driving the
// REAL src/review-commit-edit.js in jsdom through the actual gestures:
//  - a click arms a commit block with the held caret; an edit key opens
//    the strike-in-place session with the keystroke applied; a letter routes
//    to the block-comment path instead (first-key dispatch, md's grammar)
//  - typing inserts marked; Enter commits + sends the [Edit] thread with a
//    region anchor on "(commit message)"; Esc reverts; clicking away commits
//    without sending (the review composer rule)
//  - a selection + ⌫ strikes the whole selection as the session's entry
//  - stored unresolved edit threads re-strike their block in place, pending
//    marks amber and sent marks slate, and restore when the thread goes
//  - a decorated block refuses re-arming (discard first / awaiting agent)
//  - the md viewer's click rules: a word arms with the wash, a gap opens the
//    editor with a block caret on the space and a word typed there gets its
//    own space, a mark
//    reopens its edit, To comment / To edit move the words both ways

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body data-review="slug"></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;

const { createCommitEditController } = require('../src/review-commit-edit');
const { mergeStoreWithJournal } = require('../src/agent-journal');

const SUBJECT = 'Fix limiter rounding';
const P1 = 'The polling utilizes a timer to refill tokens.';
const P2 = 'Second paragraph of rationale here.';
document.body.innerHTML = [
  '<main><section id="commit" class="card" data-path="(commit message)">',
  '<h2>Commit message</h2>',
  `<div class="commit-subject">${SUBJECT}</div>`,
  `<div class="commit-body"><p>${P1}</p><p>${P2}</p></div>`,
  '</section></main>',
].join('');

const subject = document.querySelector('.commit-subject');
const [p1, p2] = document.querySelectorAll('.commit-body p');

const addCalls = [];
const updateCalls = [];
const discardCalls = [];
const sendPendingCalls = [];
const blockComments = [];
const toasts = [];
let needsSendFlag = true;
const io = {
  platform: 'darwin',
  addEditThread: (item) => { addCalls.push(item); return Promise.resolve({ success: true }); },
  updateEditThread: (item) => { updateCalls.push(item); return Promise.resolve({ success: true }); },
  discardThread: (id) => { discardCalls.push(id); return Promise.resolve({ success: true }); },
  sendPending: (opts) => { sendPendingCalls.push(opts); },
  openBlockComment: (block, seed, range) => { blockComments.push({ block, seed, range }); },
  composerBlocked: () => false,
  sendLabel: () => 'Send',
  threadNeedsSend: () => needsSendFlag,
  onToast: (m) => { toasts.push(m); },
  onEditStart: () => {},
};
const ctl = createCommitEditController(io);
ctl.bind();

let passed = 0; let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}`); if (detail !== undefined) console.log('  got:', detail); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function click(el) { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }
function mousedown(el) { el.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); }
function key(el, opts) {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts }));
}
function typeChar(el, ch) {
  el.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true, cancelable: true, inputType: 'insertText', data: ch,
  }));
}
const strip = () => document.querySelector('.rv-edit-compose');
const armedWash = (el) => el.classList.contains('rv-edit-armed');

// jsdom has no layout: `aim` names the text spot the hit-test returns, and
// every range box holds the click point.
const BOX = { width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 };
dom.window.Range.prototype.getClientRects = () => [BOX];
let aimed = null;
document.caretRangeFromPoint = () => {
  if (!aimed || !aimed.node.isConnected) return null;
  const r = document.createRange();
  r.setStart(aimed.node, aimed.offset);
  r.collapse(true);
  return r;
};
function aim(el, needle, delta = 0) {
  const w = document.createTreeWalker(el, 4, null);
  let n;
  while ((n = w.nextNode())) {
    const i = n.data.indexOf(needle);
    if (i >= 0) { aimed = { node: n, offset: i + delta }; return; }
  }
  throw new Error(`no ${needle}`);
}
// After the block's last character: where a click adds a word at the end.
function aimEnd(el) {
  const nodes = [];
  const w = document.createTreeWalker(el, 4, null);
  let n;
  while ((n = w.nextNode())) nodes.push(n);
  const last = nodes.reverse().find((t) => /\S/.test(t.data));
  aimed = { node: last, offset: last.data.search(/\S\s*$/) + 1 };
}
const clickAt = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }));
// A beforeinput delete of the char before the caret, as Chromium hands it over.
function erase(el) {
  const r = window.getSelection().getRangeAt(0);
  const ev = new dom.window.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
  ev.getTargetRanges = () => [{ startContainer: r.startContainer, startOffset: r.startOffset - 1, endContainer: r.startContainer, endOffset: r.startOffset }];
  el.dispatchEvent(ev);
}
function select(el, needle, len = needle.length) {
  const w = document.createTreeWalker(el, 4, null);
  let n;
  while ((n = w.nextNode())) {
    const i = n.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + len);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    return r;
  }
  throw new Error(`no ${needle}`);
}

async function run() {
  // — a click on a word arms the block for a comment: the wash, no caret, and
  //   ⌫ there has nothing to act on —
  click(subject);
  check('a click on a word arms the block with the wash and no caret',
    armedWash(subject) && !subject.querySelector('span'));
  key(subject, { key: 'Backspace' });
  check('⌫ on an armed block opens no edit', !ctl.isEditing());
  click(document.body);

  // — a selection + ⌫ opens the session, striking the selection —
  select(subject, SUBJECT.slice(-1));
  key(subject, { key: 'Backspace' });
  check('selection + ⌫ opens the session', ctl.isEditing());
  check('the session block is contenteditable', subject.getAttribute('contenteditable') === 'true');
  check('the editor has no wash', !armedWash(subject));
  check('the composer strip sits under the block', !!strip());
  const del1 = subject.querySelector('del.md-pending-del');
  check('the entry ⌫ strikes the selected char', !!del1 && del1.textContent === SUBJECT.slice(-1), del1 && del1.textContent);

  // — typing inserts marked; Enter commits + sends —
  typeChar(subject, 'x');
  const ins1 = subject.querySelector('ins.md-pending-ins');
  check('typing inserts a marked char', !!ins1 && ins1.textContent === 'x');
  key(subject, { key: 'Enter' });
  await sleep(5);
  check('enter closes the session', !ctl.isEditing() && !strip());
  check('the block is restored (store is the single truth)', subject.innerHTML === SUBJECT, subject.innerHTML);
  check('one edit thread was added, with send', addCalls.length === 1 && addCalls[0].alsoSend === true);
  const sent = addCalls[0] || {};
  check('the body is an [Edit] envelope with the marks',
    /^\[Edit\]\n/.test(sent.body || '') && /<del>/.test(sent.body || '') && /<ins>x<\/ins>/.test(sent.body || ''), sent.body);
  check('the anchor is a whole-block region on the commit message',
    sent.anchor && sent.anchor.path === '(commit message)' && sent.anchor.wholeBlock === true
    && sent.anchor.heading === 'Commit message' && sent.anchor.snippet === SUBJECT, sent.anchor);

  // — Esc reverts, nothing written —
  select(p1, 'timer');
  key(p1, { key: '.' });
  check('punctuation over a selection opens the session typing over it',
    ctl.isEditing() && !!p1.querySelector('ins.md-pending-ins') && !!p1.querySelector('del.md-pending-del'));
  key(p1, { key: 'Escape' });
  check('esc reverts the block verbatim', !ctl.isEditing() && p1.innerHTML === P1, p1.innerHTML);
  check('esc adds no thread', addCalls.length === 1);
  window.getSelection().removeAllRanges();

  // — on an armed block every typed character opens a comment on it —
  click(p2);
  key(p2, { key: 'a' });
  check('a letter on an armed block opens the block comment',
    !ctl.isEditing() && blockComments.length === 1 && blockComments[0].block === p2 && blockComments[0].seed === 'a');
  click(p2);
  key(p2, { key: '3' });
  check('a digit on an armed block opens the block comment too',
    !ctl.isEditing() && blockComments.length === 2 && blockComments[1].block === p2 && blockComments[1].seed === '3');
  click(p2);
  key(p2, { key: '(' });
  check('so does punctuation: an armed block has no caret to edit at',
    !ctl.isEditing() && blockComments.length === 3 && blockComments[2].seed === '(');
  check('a whole-block comment offers no To edit', (() => {
    const r = document.createRange(); r.selectNodeContents(p2); return ctl.blockForRange(r) === null;
  })());
  click(document.body);

  // — a letter over a selection is the page's quote comment, not a block comment —
  click(p2);
  select(p2, 'rationale');
  const letterOnSel = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'q' });
  p2.dispatchEvent(letterOnSel);
  check('a letter over a selection is left to the page (it quotes the selection)',
    blockComments.length === 3 && !letterOnSel.defaultPrevented);
  window.getSelection().removeAllRanges();
  click(document.body);

  // — selection + ⌫ strikes the selection; click-away commits without send —
  const sel = window.getSelection();
  const range = document.createRange();
  const t1 = p1.firstChild; // "The polling utilizes a timer..."
  range.setStart(t1, P1.indexOf('utilizes'));
  range.setEnd(t1, P1.indexOf('utilizes') + 'utilizes '.length);
  sel.removeAllRanges();
  sel.addRange(range);
  key(p1, { key: 'Backspace' });
  const selDel = p1.querySelector('del.md-pending-del');
  check('selection + ⌫ strikes the selection as the entry',
    ctl.isEditing() && !!selDel && selDel.textContent === 'utilizes ', selDel && selDel.textContent);
  mousedown(document.querySelector('#commit h2'));
  await sleep(5);
  check('click-away commits the edit without sending',
    !ctl.isEditing() && addCalls.length === 2 && addCalls[1].alsoSend === false);
  check('the committed body strikes the selection', /<del>utilizes <\/del>/.test(addCalls[1].body), addCalls[1].body);
  check('the block is restored after click-away commit', p1.innerHTML === P1, p1.innerHTML);

  // — decoration from stored threads —
  const editThread = {
    id: 'e1',
    status: 'open',
    anchor_status: 'ok',
    anchor: { path: '(commit message)', snippet: P1, wholeBlock: true, heading: 'Commit message' },
    messages: [{ author: 'user', body: '[Edit]\nThe polling <del>utilizes </del><ins>uses </ins>a timer to refill tokens.\n[/Edit]', ts: 5 }],
  };
  needsSendFlag = true;
  let placed = ctl.decorateEditThreads([editThread]);
  check('an unresolved edit re-strikes its block in place',
    placed.get('e1') === p1 && !!p1.querySelector('del.md-pending-del') && !!p1.querySelector('ins.md-pending-ins'));
  check('pending marks wear the amber/rose classes', !p1.querySelector('.md-sent-del, .md-sent-ins'));
  check('decoratedBlockFor answers the placement pass', ctl.decoratedBlockFor('e1') === p1);

  needsSendFlag = false;
  placed = ctl.decorateEditThreads([editThread]);
  check('sent marks rest in slate',
    placed.get('e1') === p1 && !!p1.querySelector('del.md-sent-del') && !p1.querySelector('.md-pending-del'));

  // — a SENT (slate) block refuses re-arming —
  click(p1);
  key(p1, { key: 'Backspace' });
  check('a sent block refuses a new edit session', !ctl.isEditing());

  // — resolved / gone threads restore the block —
  ctl.decorateEditThreads([]);
  check('removing the thread restores the block verbatim', p1.innerHTML === P1, p1.innerHTML);

  // Resolving can mean keeping the current text after considering an edit.
  // A later refinement must not re-strike that completed suggestion even when
  // its original text still matches the current commit message.
  const resolvedEvents = [{ thread: 'e1', status: 'resolved', ts: 10 }];
  const completed = mergeStoreWithJournal({ threads: [editThread] }, resolvedEvents).threads[0];
  placed = ctl.decorateEditThreads([completed]);
  check('a completed commit edit leaves the current text clean', !placed.has('e1') && p1.innerHTML === P1);
  const refining = mergeStoreWithJournal({ threads: [{ ...editThread, messages: [
    ...editThread.messages, { author: 'user', body: 'Try a shorter phrase instead.', ts: 20 },
  ] }] }, resolvedEvents).threads[0];
  placed = ctl.decorateEditThreads([refining]);
  check('a follow-up reopens the commit conversation', !refining.status);
  check('a follow-up does not restore the completed commit edit', !placed.has('e1') && p1.innerHTML === P1);
  ctl.decorateEditThreads([]);

  // — revisit: a pending user-only edit re-enters in place —
  needsSendFlag = true;
  ctl.decorateEditThreads([editThread]);
  check('a pending user-only edit marks its block revisitable', p1.classList.contains('rv-edit-revisitable'));
  click(p1);
  check('a click on a revisitable block\'s words arms it', armedWash(p1));
  click(document.body);
  aimEnd(p1);
  clickAt(p1); // after the last word: the edit reopens there
  erase(p1); // strikes the final "."
  check('a click after the last word reopens the edit with the marks kept',
    ctl.isEditing() && p1.getAttribute('contenteditable') === 'true'
    && !!p1.querySelector('ins.md-pending-ins'));
  await sleep(5);
  mousedown(document.querySelector('#commit h2'));
  await sleep(5);
  check('click-away updates the stored thread instead of adding one',
    !ctl.isEditing() && addCalls.length === 2 && updateCalls.length === 1
    && updateCalls[0].threadId === 'e1' && updateCalls[0].alsoSend === false);
  check('the updated envelope keeps the old marks and adds the new strike',
    /<del>utilizes <\/del>/.test(updateCalls[0].body) && /<del>\.<\/del>/.test(updateCalls[0].body),
    updateCalls[0].body);
  check('the block returns clean until the store re-decorates', p1.innerHTML === P1, p1.innerHTML);

  // — revisit seeds the note; Esc restores the decorated resting state —
  const e1v2 = {
    ...editThread,
    messages: [{ author: 'user', body: updateCalls[0].body, ts: 6 },
               { author: 'user', body: 'trim it', ts: 6 }],
  };
  ctl.decorateEditThreads([e1v2]);
  // The final "." is struck, so the block's end is the user's own mark:
  // a click on it reopens the edit there.
  const struckEnd = Array.from(p1.querySelectorAll('del.md-pending-del')).pop();
  aimed = { node: struckEnd.firstChild, offset: 1 };
  struckEnd.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }));
  const noteTa = document.querySelector('.rv-edit-compose textarea');
  check('revisit seeds the note from the stored second message',
    ctl.isEditing() && noteTa && noteTa.value === 'trim it', noteTa && noteTa.value);
  key(p1, { key: 'Escape' });
  check('esc restores the marked resting state, still revisitable',
    !ctl.isEditing() && !!p1.querySelector('del.md-pending-del')
    && p1.classList.contains('rv-edit-revisitable') && ctl.decoratedBlockFor('e1') === p1);
  check('esc leaves the store untouched', updateCalls.length === 1);
  ctl.decorateEditThreads([]);

  // — dissolving every mark on a revisit discards the thread —
  const insThread = {
    id: 'e2',
    status: 'open',
    anchor_status: 'ok',
    anchor: { path: '(commit message)', snippet: P2, wholeBlock: true, heading: 'Commit message' },
    messages: [{ author: 'user', body: '[Edit]\nSecond paragraph of rationale here.<ins> Extra.</ins>\n[/Edit]', ts: 7 }],
  };
  ctl.decorateEditThreads([insThread]);
  const insEl = p2.querySelector('ins.md-pending-ins');
  check('the pure insertion decorates in place', !!insEl && insEl.textContent === ' Extra.');
  const insRange = document.createRange();
  insRange.selectNodeContents(insEl);
  const sel2 = window.getSelection();
  sel2.removeAllRanges();
  sel2.addRange(insRange);
  key(p2, { key: 'Backspace' }); // deleting your own insertion removes it → zero marks
  await sleep(5);
  mousedown(document.querySelector('#commit h2'));
  await sleep(5);
  check('dissolving every mark on a revisit discards the thread',
    !ctl.isEditing() && discardCalls.length === 1 && discardCalls[0] === 'e2'
    && updateCalls.length === 1 && p2.innerHTML === P2, { discardCalls, html: p2.innerHTML });
  check('a click-away commit never flushes pending threads', sendPendingCalls.length === 0);
  ctl.decorateEditThreads([]);

  // — Send on a mark-less session still keeps its "Send all" promise: nothing
  //   is written for THIS edit, but the host is asked to flush what's pending —
  aimEnd(p2);
  clickAt(p2); // the editor opens after the last word, nothing typed
  check('a click after the last word opens a mark-less session with the gap caret',
    ctl.isEditing() && p2.classList.contains('md-gap-caret') && !p2.querySelector('del.md-pending-del, ins.md-pending-ins'));
  const moved = document.createRange();
  moved.setStart(p2.firstChild, 3);
  moved.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(moved);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
  check('moving the caret off the gap ends the gap caret', !p2.classList.contains('md-gap-caret'));
  key(p2, { key: 'Enter' });
  await sleep(5);
  check('send on a mark-less fresh session adds nothing and flushes pending',
    !ctl.isEditing() && addCalls.length === 2 && sendPendingCalls.length === 1
    && p2.innerHTML === P2, { addCalls: addCalls.length, sendPendingCalls });

  // — Send on a dissolved revisit discards the thread, then flushes —
  ctl.decorateEditThreads([insThread]);
  const insEl2 = p2.querySelector('ins.md-pending-ins');
  const insRange2 = document.createRange();
  insRange2.selectNodeContents(insEl2);
  sel2.removeAllRanges();
  sel2.addRange(insRange2);
  key(p2, { key: 'Backspace' }); // dissolve the only mark
  await sleep(5);
  key(p2, { key: 'Enter' }); // Send
  await sleep(5);
  check('send on a dissolved revisit discards the thread, then flushes pending',
    !ctl.isEditing() && discardCalls.length === 2 && discardCalls[1] === 'e2'
    && sendPendingCalls.length === 2 && p2.innerHTML === P2,
    { discardCalls, sendPendingCalls });
  ctl.decorateEditThreads([]);

  // — undo restores the caret where the undone action began —
  function rawCaretOffset(root) {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    let sum = 0;
    const w = document.createTreeWalker(root, 4, null);
    let n;
    while ((n = w.nextNode())) {
      if (n === r.startContainer) return sum + r.startOffset;
      sum += n.data.length;
    }
    return null;
  }
  const at = P2.indexOf('paragraph ');
  const r2 = document.createRange();
  r2.setStart(p2.firstChild, at);
  r2.setEnd(p2.firstChild, at + 'paragraph '.length);
  const sel3 = window.getSelection();
  sel3.removeAllRanges();
  sel3.addRange(r2);
  key(p2, { key: 'Backspace' }); // entry: strike the selection, caret after the del
  await sleep(5);
  typeChar(p2, 'q');
  await sleep(5);
  key(p2, { key: 'z', metaKey: true }); // undo the insert
  check('undo removes the insert and restores its caret',
    !p2.querySelector('ins.md-pending-ins') && rawCaretOffset(p2) === at + 'paragraph '.length,
    rawCaretOffset(p2));
  key(p2, { key: 'z', metaKey: true }); // undo the strike
  check('a second undo restores the block and the pre-strike caret',
    !p2.querySelector('del.md-pending-del') && rawCaretOffset(p2) === at, rawCaretOffset(p2));
  key(p2, { key: 'Escape' });

  // — the md viewer's click rules on the commit blocks —
  {
    const stripBtn = (label) => strip() && Array.from(strip().querySelectorAll('button')).find((b) => b.textContent.startsWith(label));

    aim(p1, 'polling', 2);
    clickAt(p1);
    check('a click on a word arms the block with the wash, no caret', !ctl.isEditing() && armedWash(p1) && !p1.querySelector('span'));
    key(p1, { key: 'Escape' });
    click(document.body);
    check('disarming takes the wash away', !p1.classList.contains('rv-edit-armed'));

    aim(p1, ' utilizes');
    clickAt(p1);
    const gapAt = window.getSelection().getRangeAt(0);
    check('a click on the space between two words opens the editor with the block caret on it',
      ctl.isEditing() && p1.classList.contains('md-gap-caret') && p1.textContent === P1
      && gapAt.startContainer.data.slice(gapAt.startOffset).startsWith(' utilizes'));
    check('a fresh gap edit offers To comment', !!stripBtn('To comment') && !stripBtn('To comment').hidden);
    for (const ch of 'quietly') typeChar(p1, ch);
    check('a word typed at the gap gets its own space', p1.textContent === 'The polling quietly utilizes a timer to refill tokens.', p1.textContent);
    check('the first key returns the bar caret', !p1.classList.contains('md-gap-caret'));
    const commentsBefore = blockComments.length;
    stripBtn('To comment').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const handed = blockComments[commentsBefore];
    check('To comment takes the words out of the message into a block comment',
      !ctl.isEditing() && p1.innerHTML === P1 && !!handed && handed.block === p1 && handed.seed === 'quietly' && !handed.range, handed);
    const whole = document.createRange();
    whole.selectNodeContents(p1);
    check('that whole-block comment offers no To edit', ctl.blockForRange(whole) === null);
    click(document.body);

    aimEnd(p1);
    clickAt(p1);
    check('a click after the last word opens the editor there with the gap caret',
      ctl.isEditing() && p1.classList.contains('md-gap-caret'));
    for (const ch of 'Daily') typeChar(p1, ch);
    check('a word typed at the end gets its own space', p1.textContent === `${P1} Daily`, p1.textContent);
    key(p1, { key: 'Escape' });

    aim(p1, 'utilizes', 0); // the near half of the word after the space
    clickAt(p1);
    check('a click on the edge of the word after a space opens the editor at the gap',
      ctl.isEditing() && p1.classList.contains('md-gap-caret'));
    p1.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, detail: 2 }));
    check('the second press of a double-click ends an untouched gap edit, for the page\'s paragraph select',
      !ctl.isEditing() && p1.innerHTML === P1);

    aim(p2, ' paragraph');
    clickAt(p2);
    key(p2, { key: 'Enter' });
    check('Enter at the gap breaks the line rather than sending',
      ctl.isEditing() && !!p2.querySelector('ins.md-pending-break') && addCalls.length === 2);
    key(p2, { key: 'Escape' });

    // A quote over one word: To edit types over it, To comment returns it to that quote.
    const at2 = P2.indexOf('rationale');
    const q = document.createRange();
    q.setStart(p2.firstChild, at2);
    q.setEnd(p2.firstChild, at2 + 'rationale'.length);
    ctl.editFromComment(q, 'reasoning');
    check('To edit from a quote strikes it and types the words over it',
      ctl.isEditing() && p2.querySelector('del.md-pending-del').textContent === 'rationale'
      && p2.querySelector('ins.md-pending-ins').textContent === 'reasoning');
    key(p2, { key: 'e', metaKey: true });
    const back = blockComments[blockComments.length - 1];
    check('To comment (⌘E) returns the words to a comment on the same quote',
      !ctl.isEditing() && p2.innerHTML === P2 && back.seed === 'reasoning' && !!back.range && back.range.toString() === 'rationale',
      back && back.range && back.range.toString());

    // An edit with more than a comment holds offers no To comment.
    aim(p2, ' paragraph');
    clickAt(p2);
    erase(p2); // strikes the "d" of "Second"
    await sleep(5); // the button follows the edit a microtask later
    check('an edit that struck text offers no To comment', ctl.isEditing() && stripBtn('To comment').hidden);
    key(p2, { key: 'Escape' });

    // A reopenable edit: a click on its marks reopens it at the click; Revert discards it.
    ctl.decorateEditThreads([{
      id: 'e9', status: 'open', anchor_status: 'ok',
      messages: [{ author: 'user', body: '[Edit]\nSecond paragraph of <ins>extra </ins>rationale here.\n[/Edit]', ts: 1, turn: 1 }],
    }]);
    const ins9 = p2.querySelector('ins.md-pending-ins');
    aimed = { node: ins9.firstChild, offset: 2 };
    ins9.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5, detail: 1 }));
    check('a click on a reopenable edit\'s mark reopens it', ctl.isEditing() && !!p2.querySelector('ins.md-pending-ins'));
    check('a reopened edit offers no To comment', stripBtn('To comment').hidden);
    const discardsBefore = discardCalls.length;
    stripBtn('Revert').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    check('Revert on a reopened edit discards it', !ctl.isEditing() && discardCalls[discardsBefore] === 'e9' && p2.innerHTML === P2);
    ctl.decorateEditThreads([]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
