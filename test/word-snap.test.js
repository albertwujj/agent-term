// A selection for a comment or an edit covers whole words (src/word-snap.js):
// an end inside a word grows to the word's edge, spaces at either end fall
// away, punctuation the drag covered stays, and the DOM form maps a range
// through the blocks its ends sit in.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

const { snapStart, snapEnd, snapRangeToWords, wordSpans, newWordSpacing, wordEraseSpan, startsNewWord } = require('../src/word-snap');

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

// The page's words: Unicode word boundaries, punctuation riding with its word.
const words = (t) => wordSpans(t).map((w) => t.slice(w.start, w.end));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('punctuation touching a word rides with it', same(words('The timer, then (maybe) waits.'), ['The', 'timer,', 'then', '(maybe)', 'waits.']), words('The timer, then (maybe) waits.'));
check('punctuation between two words splits them, going with the one before',
  same(words('book/books well-known a+b'), ['book/', 'books', 'well-', 'known', 'a+', 'b']), words('book/books well-known a+b'));
check('a word knows where its letters end, before the punctuation after them',
  same(wordSpans('the timer, waits.').map((w) => w.wordEnd), [3, 9, 16]), wordSpans('the timer, waits.'));
check('a word Unicode keeps whole stays whole', same(words("don't 3.14 1,000 e.g. node.js foo_bar"), ["don't", '3.14', '1,000', 'e.g.', 'node.js', 'foo_bar']),
  words("don't 3.14 1,000 e.g. node.js foo_bar"));
const zh = words('我们今天开会。');
check('Chinese splits into words, the full stop riding with the last', zh.length >= 2 && zh.join('') === '我们今天开会。' && zh[zh.length - 1].endsWith('。'), zh);
const jaLead = words('「計画」です');
check('leading punctuation joins the word after it', jaLead[0].startsWith('「') && jaLead.join('') === '「計画」です', jaLead);

// Text typed at a resting caret: a new word gets its spaces, except between
// two words with no space between them, where you type what joins them.
check('a new word between spaced words gets a space', same(newWordSpacing('x', 3, 'foo bar'), { lead: ' ', trail: '' }), newWordSpacing('x', 3, 'foo bar'));
check('between two words joined without a space it goes in as typed', newWordSpacing('x', 5, 'book/books') === null, newWordSpacing('x', 5, 'book/books'));
check('replacing a struck word before its comma still spaces it', same(newWordSpacing('clock', 5, 'timer,'), { lead: ' ', trail: '' }), newWordSpacing('clock', 5, 'timer,'));

// The span a page word's erase takes: the spaces up to the caret go with
// the word unless that would join the text either side; from a word's
// wordEnd, only the side pressed toward.
const erase = (t, caret, backward) => {
  const ws = wordSpans(t);
  const w = backward ? ws.filter((x) => x.start < caret).pop() : ws.find((x) => x.end > caret);
  const { from, to } = wordEraseSpan(t, w, caret, backward);
  return t.slice(0, from) + t.slice(to);
};
check('Delete takes the spaces before the word', erase('the poller reads', 3, false) === 'the reads', erase('the poller reads', 3, false));
check('but not when the word is joined to the next', erase('the book/books', 3, false) === 'the books', erase('the book/books', 3, false));
check('⌫ takes the word after the slash alone', erase('the book/books', 14, true) === 'the book/', erase('the book/books', 14, true));
check('⌫ before a full stop takes the letters and keeps the stop', erase('it waits.', 8, true) === 'it .', erase('it waits.', 8, true));
check('Delete there takes the stop alone', erase('it waits.', 8, false) === 'it waits', erase('it waits.', 8, false));
check('⌫ after the stop takes the word with it', erase('it waits.', 9, true) === 'it ', erase('it waits.', 9, true));

// An undo step is a word: a typed key, or a letter ⌫ erases, starts a step
// when it starts another word.
check('a letter after a word and its space starts a word', startsNewWord('the ', 'f'));
check('a letter after a slash starts a word', startsNewWord('book/', 'b'));
check('the slash itself rides with the word before', !startsNewWord('book', '/'));
check('an apostrophe inside a word does not split it', !startsNewWord("don'", 't'));
check('spaces typed ahead of a word ride with it', !startsNewWord('  ', 'w'));
check('⌫ through a word and the space before it is one step', !startsNewWord('poller', ' ', true) && !startsNewWord('oller', 'p', true));
check('⌫ reaching the word before starts a step', startsNewWord(' poller', 'e', true));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
