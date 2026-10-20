// Run with: node test/review-symbol-scan.test.js
// The text half of the review's symbol scan: which word a right-click names,
// which occurrences count, and how the page's text maps back to ranges. The
// gestures and the rail run in the real app (test/e2e/review-symbol-scan.mjs).
const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.NodeFilter = dom.window.NodeFilter;

const {
  wordAround,
  findOccurrences,
  indexText,
  rangeAt,
} = require('../src/review-symbol-scan');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

check('a right-click names the word it lands in, or the one its caret ends', () => {
  const text = 'foo.bar_baz(x)';
  assert.deepStrictEqual(wordAround(text, 1), { start: 0, end: 3 });
  assert.deepStrictEqual(wordAround(text, 3), { start: 0, end: 3 }, 'caret just past foo');
  assert.deepStrictEqual(wordAround(text, 6), { start: 4, end: 11 }, '_ is part of the word');
  assert.strictEqual(wordAround('a + b', 2), null, 'off any word');
  assert.deepStrictEqual(wordAround('größe2 x', 2), { start: 0, end: 6 }, 'letters beyond ASCII');
});

check('a word search keeps whole words and case; a selection search keeps any run', () => {
  const text = 'id width ID id_x x.id hidden id';
  assert.deepStrictEqual(findOccurrences(text, 'id', { word: true }), [0, 19, 29]);
  assert.deepStrictEqual(findOccurrences(text, 'id', { word: false }), [0, 4, 12, 19, 23, 29]);
  assert.deepStrictEqual(findOccurrences('aaaa', 'aa', { word: false }), [0, 2], 'no overlaps');
  assert.deepStrictEqual(findOccurrences(text, '', { word: true }), []);
});

check('the index spans inline markup, breaks at blocks, and skips the excluded', () => {
  document.body.innerHTML = [
    '<main>',
    '<table><tr><td class="ln">12</td><td class="code"><span>foo</span>.<span>bar</span>(foo)</td></tr>',
    '<tr><td class="ln">13</td><td class="code">bar</td></tr></table>',
    '<div class="rv-thread">foo in a comment</div>',
    '<p>Calls <code>foo</code> once.</p>',
    '</main>',
  ].join('');
  const index = indexText(document.querySelector('main'), '.ln, .rv-thread');
  assert.strictEqual(index.text, 'foo.bar(foo)\nbar\nCalls foo once.');
  const starts = findOccurrences(index.text, 'foo', { word: true });
  assert.deepStrictEqual(starts, [0, 8, 23]);
  assert.deepStrictEqual(findOccurrences(index.text, 'barbar', { word: false }), [], 'no match across cells');
  const across = rangeAt(index, 0, 'foo.bar'.length);
  assert.strictEqual(String(across), 'foo.bar', 'a range across token spans');
  assert.strictEqual(String(rangeAt(index, 23, 26)), 'foo');
  const code = document.querySelector('p code').firstChild;
  assert.strictEqual(index.startOf.get(code), 23, 'a text node maps to its offset');
});

console.log(`\n${passed} passed`);
