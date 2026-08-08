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
const blockComments = [];
const toasts = [];
let needsSendFlag = true;
const io = {
  platform: 'darwin',
  addEditThread: (item) => { addCalls.push(item); return Promise.resolve({ success: true }); },
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

  // — a decorated block refuses re-arming —
  click(p1);
  key(p1, { key: 'Backspace' });
  check('a decorated block refuses a new edit session', !ctl.isEditing());

  // — resolved / gone threads restore the block —
  ctl.decorateEditThreads([]);
  check('removing the thread restores the block verbatim', p1.innerHTML === P1, p1.innerHTML);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
