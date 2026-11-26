// A selection for a comment or an edit covers whole words (src/word-snap.js):
// an end inside a word grows to the word's edge, spaces at either end fall
// away, punctuation the drag covered stays, and the DOM form maps a range
// through the blocks its ends sit in.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

const { snapStart, snapEnd, snapRangeToWords } = require('../src/word-snap');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

const text = 'The polling utilizes a timer, then waits.';
const span = (s, e) => text.slice(snapStart(text, s), snapEnd(text, e));

check('an end inside a word grows to the word\'s edge', span(text.indexOf('lling'), text.indexOf('ilizes')) === 'polling utilizes', span(text.indexOf('lling'), text.indexOf('ilizes')));
check('ends already on word edges stay', span(4, 11) === 'polling');
check('spaces at either end fall away', span(3, 12) === 'polling', span(3, 12));
check('punctuation the drag covered stays', span(text.indexOf('timer'), text.indexOf(',') + 1) === 'timer,');
check('punctuation it stopped short of is left out', span(text.indexOf('mer'), text.indexOf(',')) === 'timer');
check('a span of only spaces collapses', snapEnd(text, 12) <= snapStart(text, 11));

const cjk = '我们今天开会讨论计划';
const cjkStart = snapStart(cjk, 1);
const cjkEnd = snapEnd(cjk, 3);
check('CJK words snap by Unicode word segmentation', cjkStart === 0 && cjkEnd >= 4, { cjkStart, cjkEnd });

document.body.innerHTML = '<p id="a">Alpha <strong>bravo</strong> charlie</p><p id="b">delta echo</p>';
const a = document.getElementById('a');
const b = document.getElementById('b');
const blockOf = (node) => (node.nodeType === 1 ? node : node.parentElement).closest('p');
{
  const r = document.createRange();
  r.setStart(a.querySelector('strong').firstChild, 2); // br|avo
  r.setEnd(a.lastChild, 4); // " ch|arlie"
  const snapped = snapRangeToWords(r, blockOf);
  check('the DOM form snaps across inline markup', snapped && snapped.toString() === 'bravo charlie', snapped && snapped.toString());
}
{
  const r = document.createRange();
  r.setStart(a.lastChild, 3); // " ch|arlie" -> charlie
  r.setEnd(b.firstChild, 7); // "delta e|cho" -> echo
  const snapped = snapRangeToWords(r, blockOf);
  check('a selection across blocks snaps each end in its own block', snapped && snapped.toString() === 'charliedelta echo', snapped && snapped.toString());
}
{
  const r = document.createRange();
  r.setStart(a.firstChild, 5); // the space after Alpha
  r.setEnd(a.firstChild, 6);
  check('a range of only a space snaps to nothing', snapRangeToWords(r, blockOf) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
