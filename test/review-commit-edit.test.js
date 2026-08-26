// Guards the review viewer's commit-message editing end to end, driving the
// REAL src/review-commit-edit.js in jsdom through the actual gestures:
//  - a click arms a commit block with the blinking caret; an edit key opens
//    the strike-in-place session with the keystroke applied; a letter routes
//    to the block-comment path instead (first-key dispatch, md's grammar)
//  - typing inserts marked; Enter commits + sends the [Edit] thread with a
//    region anchor on "(commit message)"; Esc reverts; clicking away commits
//    without sending (the review composer rule)
//  - a selection + ⌫ strikes the whole selection as the session's entry
//  - stored unresolved edit threads re-strike their block in place, pending
//    marks amber and sent marks slate, and restore when the thread goes
//  - a decorated block refuses re-arming (discard first / awaiting agent)

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body data-review="slug"></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;

const { createCommitEditController } = require('../src/review-commit-edit');

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
  openBlockComment: (block, seed) => { blockComments.push({ block, seed }); },
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
const caret = () => document.querySelector('span.rv-edit-caret');

async function run() {
  // — arm + entry ⌫ at the (fallback end-of-block) caret —
  click(subject);
  check('a click arms the block with a blinking caret', !!caret() && subject.contains(caret()));
  key(subject, { key: 'Backspace' });
  check('an edit key opens the session', ctl.isEditing());
  check('the session block is contenteditable', subject.getAttribute('contenteditable') === 'true');
  check('the caret span is gone once editing starts', !caret());
  check('the composer strip sits under the block', !!strip());
  const del1 = subject.querySelector('del.md-pending-del');
  check('entry ⌫ strikes the char before the caret', !!del1 && del1.textContent === SUBJECT.slice(-1), del1 && del1.textContent);

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
  click(p1);
  key(p1, { key: '3' });
  check('a digit entry opens the session with the char marked',
    ctl.isEditing() && !!p1.querySelector('ins.md-pending-ins'));
  key(p1, { key: 'Escape' });
  check('esc reverts the block verbatim', !ctl.isEditing() && p1.innerHTML === P1, p1.innerHTML);
  check('esc adds no thread', addCalls.length === 1);

  // — a letter routes to the comment path —
  click(p2);
  key(p2, { key: 'a' });
  check('a letter on an armed block opens the block comment instead',
    !ctl.isEditing() && blockComments.length === 1 && blockComments[0].block === p2 && blockComments[0].seed === 'a');

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

  // — revisit: a pending user-only edit re-enters in place —
  needsSendFlag = true;
  ctl.decorateEditThreads([editThread]);
  check('a pending user-only edit marks its block revisitable', p1.classList.contains('rv-edit-revisitable'));
  click(p1);
  check('clicking a revisitable block arms it', !!caret());
  key(p1, { key: 'Backspace' }); // caret fallback = end → strikes the final "."
  check('an edit key re-enters the session with the marks kept',
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
  click(p1);
  key(p1, { key: '5' });
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
  click(p2);
  key(p2, { key: 'ArrowLeft' }); // arrows enter the editor without inserting
  check('arrow entry opens a mark-less session',
    ctl.isEditing() && !p2.querySelector('del.md-pending-del, ins.md-pending-ins'));
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
