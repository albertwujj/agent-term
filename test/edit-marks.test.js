// Erase rules of the shared strike-in-place engine (src/edit-marks.js), on
// real jsdom ranges: erasing original text strikes it, erasing your own
// change takes it back (an insertion leaves, a strike comes back), and a run
// of erases keeps the job its first erase found.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

const { createMarkEngine, settleGapInsertions } = require('../src/edit-marks');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

let undoSteps = 0;
const engine = createMarkEngine({ beforeMutate: () => { undoSteps++; } });
const sel = () => window.getSelection();

function block(html) {
  document.body.innerHTML = '';
  const el = document.createElement('p');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// On-screen text position (struck text counts) -> DOM point.
function at(el, offset) {
  const walker = document.createTreeWalker(el, 4, null);
  let left = offset; let n; let last = null;
  while ((n = walker.nextNode())) {
    if (left < n.data.length) return [n, left];
    left -= n.data.length;
    last = n;
  }
  return [last, last.data.length];
}
function caretTo(el, offset) {
  const r = document.createRange();
  r.setStart(...at(el, offset));
  r.collapse(true);
  sel().removeAllRanges();
  sel().addRange(r);
}
function caretOffset(el) {
  const s = sel();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(s.anchorNode, s.anchorOffset);
  return r.toString().length;
}
function span(el, start, end) {
  const r = document.createRange();
  r.setStart(...at(el, start));
  r.setEnd(...at(el, end));
  return r;
}
// One ⌫ (or Delete) at the caret, as the browser's target range would be.
function press(el, { backward = true, repeat = false } = {}) {
  const c = caretOffset(el);
  const r = backward ? span(el, c - 1, c) : span(el, c, c + 1);
  engine.eraseInBlock(el, r, { backward, repeat });
}
function eraseSelection(el, start, end) {
  const r = span(el, start, end);
  sel().removeAllRanges();
  sel().addRange(r.cloneRange());
  engine.eraseInBlock(el, r, { selection: true });
}
const marks = (el) => el.innerHTML
  .replace(/<del class="md-pending-del">/g, '[').replace(/<\/del>/g, ']')
  .replace(/<ins class="md-pending-ins">/g, '{').replace(/<\/ins>/g, '}');

{
  const el = block('one two');
  caretTo(el, 7);
  press(el);
  press(el);
  check('erasing original text strikes it, the caret walking left', marks(el) === 'one t[wo]' && caretOffset(el) === 5, marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del> three');
  caretTo(el, 7); // just past the strike
  press(el);
  check('erasing a strike from just past it brings its last char back', marks(el) === 'one [tw]o three' && caretOffset(el) === 6, marks(el));
  press(el);
  press(el);
  check('erasing on takes the whole strike back', marks(el) === 'one two three' && !el.querySelector('del'), marks(el));
  const before = undoSteps;
  press(el, { repeat: true });
  check('held, the take-back stops at the end of the marks', marks(el) === 'one two three' && caretOffset(el) === 4 && undoSteps === before, marks(el));
  press(el);
  check('the next press strikes on', marks(el) === 'one[ ]two three', marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del> three');
  caretTo(el, 13);
  for (let i = 0; i < 5; i++) press(el); // "three"
  check('strikes with only a space between join into one, the space struck',
    marks(el) === 'one [two three]' && el.querySelectorAll('del').length === 1, marks(el));
  press(el);
  check('a striking run hops an older strike in one press, never bringing it back', marks(el) === 'one [two three]' && caretOffset(el) === 4, marks(el));
  press(el);
  check('and strikes on past it', marks(el) === 'one[ two three]', marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del> three');
  caretTo(el, 4); // just before the strike
  press(el, { backward: false });
  check('Delete takes a strike back from just before it', marks(el) === 'one t[wo] three' && caretOffset(el) === 5, marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del> three');
  eraseSelection(el, 4, 7);
  check('erasing a selection of struck text brings it back', marks(el) === 'one two three' && caretOffset(el) === 7, marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del> three');
  eraseSelection(el, 2, 9);
  check('a selection holding original text strikes it and keeps the strike', marks(el) === 'on[e two t]hree', marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del><ins class="md-pending-ins">2</ins> three');
  eraseSelection(el, 4, 8);
  check('a selection of your own changes takes all of them back', marks(el) === 'one two three' && caretOffset(el) === 7, marks(el));
}

{
  const el = block('one <del class="md-pending-del">two</del><ins class="md-pending-ins">2</ins> three');
  caretTo(el, 8);
  press(el);
  press(el);
  check('erasing a replacement takes back the insertion, then the strike', marks(el) === 'one [tw]o three', marks(el));
}

{
  const el = block('a <del class="md-pending-del"><strong>bc</strong>d</del> e');
  caretTo(el, 4);
  press(el);
  check('a strike over markup splits with it', el.innerHTML === 'a <del class="md-pending-del"><strong>b</strong></del><strong>c</strong><del class="md-pending-del">d</del> e', el.innerHTML);
}

{
  const el = block('a <del class="md-pending-del">x<strong>b</strong></del> e');
  caretTo(el, 4);
  press(el);
  check('no empty markup is left behind in the strike', el.innerHTML === 'a <del class="md-pending-del">x</del><strong>b</strong> e', el.innerHTML);
}

{
  const el = block('<del class="md-pending-del">ab</del><ins class="md-pending-ins">X</ins><del class="md-pending-del">cd</del> e');
  caretTo(el, 3);
  press(el);
  check('taking back an insertion between strikes joins them', marks(el) === '[abcd] e' && caretOffset(el) === 2, marks(el));
  press(el, { backward: false });
  check('the caret stays between them, where the insertion was', marks(el) === '[ab]c[d] e', marks(el));
}

// A word typed at a gap (the caret just before the space between two words)
// enters with a space of its own; closing punctuation joins the word before.
{
  const el = block('foo bar');
  caretTo(el, 3);
  const ins = engine.insertAtGap('baz', el);
  check('a word typed at a gap gets its own space', el.textContent === 'foo baz bar' && ins && ins.hasAttribute('data-md-gap'), el.innerHTML);
  engine.insertMarkedInBlock('z');
  check('typing on extends the same word',
    el.querySelectorAll('ins').length === 1 && el.querySelector('ins').textContent === ' bazz' && el.textContent === 'foo bazz bar', el.innerHTML);
}
{
  const el = block('foo bar');
  caretTo(el, 3);
  engine.insertAtGap(',', el);
  check('closing punctuation at a gap joins the word before', el.textContent === 'foo, bar' && !el.querySelector('[data-md-gap]'), el.innerHTML);
}
{
  const el = block('foo bar');
  caretTo(el, 3);
  engine.insertAtGap('baz', el);
  engine.insertMarkedInBlock(' ');
  engine.insertMarkedInBlock(' ');
  settleGapInsertions(el);
  check('commit drops typed trailing spaces against the gap\'s own', el.textContent === 'foo baz bar', JSON.stringify(el.textContent));
}
{
  const el = block('foo <ins class="md-pending-ins" data-md-gap=""> </ins>bar');
  settleGapInsertions(el);
  check('a gap insertion left with only its space goes', el.innerHTML === 'foo bar', el.innerHTML);
}
{
  const el = block('foo <ins class="md-pending-ins">x </ins> bar');
  settleGapInsertions(el);
  check('insertions made elsewhere keep their typed spaces', el.textContent === 'foo x  bar', el.innerHTML);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
