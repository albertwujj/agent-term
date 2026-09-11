// Sentence offsets plus the real viewer's gesture -> comment payload path.
// Native click counting and selection defaults are covered by the Electron test.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { findSentenceRange } = require('../src/sentence-selection');

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`PASS ${name}`);
  passed++;
}

const cases = [
  ['One sentence. Another sentence! Last?', 'Another', 'Another sentence!'],
  ['First. Keep this clause, and that one; also this: yes. Last.', 'clause', 'Keep this clause, and that one; also this: yes.'],
  ['First. Dr. Smith uses v1.2.3 and 3.14. Last.', 'Smith', 'Dr. Smith uses v1.2.3 and 3.14.'],
  ['Use e.g. This example. Next.', 'example', 'Use e.g. This example.'],
  ['Open https://example.com/a?x=1 or docs/README.md. Next.', 'README', 'Open https://example.com/a?x=1 or docs/README.md.'],
  ['Before. He said, “Go now!” After.', 'now', 'He said, “Go now!”'],
  ['Before. A soft\nwrap continues here. After.', 'continues', 'A soft\nwrap continues here.'],
  ['  One sentence without a terminator  ', 'sentence', 'One sentence without a terminator'],
  ['第一句话。第二句话！第三句话？', '第二', '第二句话！'],
  ['Before. Emoji 🐕 stays whole. After.', '🐕', 'Emoji 🐕 stays whole.'],
];
for (const [text, needle, expected] of cases) {
  const range = findSentenceRange(text, text.indexOf(needle));
  check(`sentence containing ${needle}`, text.slice(range.start, range.end), expected);
}
const codeText = 'Before. Run one(). Two() now. After.';
const codeStart = codeText.indexOf('one()');
const protectedRange = findSentenceRange(codeText, codeStart,
  [{ start: codeStart, end: codeStart + 'one(). Two()'.length }]);
check('inline code punctuation stays inside the prose sentence',
  codeText.slice(protectedRange.start, protectedRange.end), 'Run one(). Two() now.');
check('boundary belongs to next sentence', findSentenceRange('One. Two.', 5), { start: 5, end: 9 });
check('trailing caret belongs to last sentence', findSentenceRange('One. Two.', 9), { start: 5, end: 9 });
check('space after terminator belongs to preceding sentence', findSentenceRange('One. Two.', 4), { start: 0, end: 4 });
for (const [text, offset] of [['', 0], ['  ', 1], ['One.', -1], ['One.', 5], ['One.', NaN]]) {
  check('invalid/empty input leaves native selection alone', findSentenceRange(text, offset), null);
}
const nativeSegmenter = Intl.Segmenter;
try {
  Intl.Segmenter = undefined;
  check('missing segmenter leaves native selection alone', findSentenceRange('One.', 1), null);
} finally { Intl.Segmenter = nativeSegmenter; }

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.Node = window.Node;
// The shared composer reads navigator.platform, independently of the viewer's
// platform option below. Match the Cmd+Enter gestures on every test host.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'MacIntel' },
});
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = clearTimeout;
window.CSS = { escape: (s) => s, highlights: new Map() };
window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }];
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 });

const { createMarkdownViewer } = require('../src/markdown-viewer');
const sentence = 'Second bold sentence, with a link and one(). Two() inside.';
const fixture = '# Heading\n\nFirst sentence. Second **bold** sentence, with [a link](https://example.com) and `one(). Two()` inside. Third sentence.\n\n'
  + '- Parent without punctuation\n  - Child first. Child second.\n\n'
  + '| A | B |\n|---|---|\n| Cell one. Cell two. | Other cell. |\n\n'
  + '```js\nfirst(); second();\nthird();\n```\n';
const sent = [];
const opened = [];
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/sentences.md', content: fixture }),
  submitMarkdownThreads: async (payload) => { sent.push(payload); return { success: true, data: { threads: [] } }; },
  readMarkdownThreads: async () => ({ success: true, data: { threads: [] } }),
  openURL: (url) => opened.push(url),
  getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
  platform: 'darwin',
});
const sleep = () => new Promise((resolve) => setTimeout(resolve, 20));
const article = (pane = 0) => document.querySelectorAll('.md-viewer-body')[pane];
const selection = () => window.getSelection().toString()
  || window.CSS.highlights.get('md-comment-selection')?.ranges[0]?.toString() || '';
const key = (key, extra = {}) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
async function reset() {
  document.caretRangeFromPoint = () => null;
  window.getSelection().removeAllRanges();
  await viewer.open({ filePath: '/fake/sentences.md' });
  await sleep();
}
function point(needle, { selector = 'p', pane = 0, offset = 1 } = {}) {
  const el = [...article(pane).querySelectorAll(selector)].find((node) => node.textContent.includes(needle));
  assert.ok(el, `target: ${needle}`);
  // Resolve afresh on each hit-test: the click caret splits/normalizes nodes.
  document.caretRangeFromPoint = () => {
    const walker = document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
    let at = el.textContent.indexOf(needle) + offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (at <= node.length) {
        const range = document.createRange(); range.setStart(node, at); range.collapse(true); return range;
      }
      at -= node.length;
    }
    return null;
  };
  return el;
}
function mouse(el, type, extra = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, detail: 3, ...extra });
  el.dispatchEvent(event);
  return event;
}
function click(el, extra = {}) {
  const down = mouse(el, 'mousedown', extra);
  mouse(el, 'mouseup', extra);
  mouse(el, 'click', extra);
  return down;
}
async function sendSelection() {
  await sleep();
  key('C');
  const box = document.querySelector('.md-comment-card textarea');
  assert.ok(box, 'comment composer');
  const before = sent.length;
  key('Enter', { metaKey: true });
  await sleep();
  assert.equal(sent.length, before + 1, 'Cmd+Enter submits the selection to the prompt');
  return sent.at(-1);
}

(async () => {
  await reset();
  let el = point('bold');
  check('triple press overrides native paragraph selection', click(el).defaultPrevented, true);
  check('sentence spans bold, link and inline code without splitting', selection(), sentence);
  let payload = await sendSelection();
  check('To prompt keeps the exact selected sentence', payload.threads[0].anchor.snippet, sentence);
  check('sentence comment is a selection, not a block', payload.threads[0].anchor.wholeBlock, false);
  check('sentence retains heading context', payload.threads[0].anchor.heading, 'Heading');
  check('To prompt is not an immediate send', payload.toPrompt, true);
  check('plain triple click never follows a link', opened.length, 0);

  await reset();
  el = point('First');
  check('single press keeps the existing block gesture', click(el, { detail: 1 }).defaultPrevented, false);
  payload = await sendSelection();
  check('single click still comments on the whole block', payload.threads[0].anchor.wholeBlock, true);
  check('block comment includes neighboring sentences', payload.threads[0].anchor.snippet.includes('Third sentence.'), true);

  for (const extra of [{ detail: 2 }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    await reset();
    check(`native/modified gesture stays native: ${JSON.stringify(extra)}`, click(point('Second'), extra).defaultPrevented, false);
  }
  await reset();
  check('code block keeps native line selection', click(point('first()', { selector: 'pre' })).defaultPrevented, false);
  await reset();
  el = point('Second');
  click(el, { detail: 1 }); key('Backspace');
  check('editor is open', !!document.querySelector('.md-rendered-editing'), true);
  check('editing keeps native selection', click(el).defaultPrevented, false);

  await reset();
  click(point('Parent', { selector: 'li' }));
  check('tight list item does not include its nested list', selection(), 'Parent without punctuation');
  await reset();
  click(point('Cell two', { selector: 'td' }));
  check('sentence does not cross a table cell', selection(), 'Cell two.');
  await reset();
  click(point('bold', { pane: 1 }));
  check('right pane selects the same sentence', selection(), sentence);
  payload = await sendSelection();
  check('right-pane comment quotes the sentence', payload.threads[0].anchor.snippet, sentence);

  for (const [from, to, detail, expected] of [
    ['Second', 'bold', 1, 'Second'],
    ['Second', 'bold', 3, 'Second'],
    ['bold', 'Second', 3, 'Second'],
  ]) {
    await reset();
    el = point(from, { offset: 0 });
    mouse(el, 'mousedown', { detail });
    point(to, { offset: 0 });
    mouse(el, 'mousemove', { clientX: 30, detail });
    mouse(el, 'mouseup', { clientX: 30, detail });
    mouse(el, 'click', { clientX: 30, detail });
    payload = await sendSelection();
    check(`drag wins over sentence selection (${from} to ${to}, click ${detail})`, payload.threads[0].anchor.snippet, expected);
  }
  viewer.close();
  window.close();
  console.log(`\n${passed} passed, 0 failed`);
})().catch(async (error) => { console.error(error); viewer.close(); await sleep(); window.close(); process.exitCode = 1; });
