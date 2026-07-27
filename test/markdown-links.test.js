// Where a clicked link in the md viewer goes, driving the REAL
// src/markdown-viewer.js in jsdom:
//  - the plain click belongs to commenting/editing everywhere, link text
//    included: it arms the block, and the hint says a modifier follows
//  - ctrl/cmd/alt+click follows — a web link to the browser, a relative path to
//    the doc it names, resolved against this doc's own directory
//  - a link is plain text while its block is being edited
//  - unsent work (an open card, a queued comment, a pending edit) blocks the
//    doc swap that following a link performs, since open() would drop it
//  - fragments and mailto: are swallowed, never handed to the app shell

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => s };
if (!dom.window.CSS.highlights) dom.window.CSS.highlights = new Map();
if (!dom.window.Highlight) dom.window.Highlight = class { constructor() {} };
dom.window.Range.prototype.getClientRects = dom.window.Range.prototype.getClientRects
  || (() => [{ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }]);
dom.window.Range.prototype.getBoundingClientRect = dom.window.Range.prototype.getBoundingClientRect
  || (() => ({ width: 10, height: 10, left: 0, right: 10, top: 0, bottom: 10 }));

const { createMarkdownViewer } = require('../src/markdown-viewer');

const FIXTURE = [
  '# Link Fixture',
  '',
  'A paragraph pointing at [the web](https://example.com/page) and at',
  '[a sibling doc](./sibling.md) in the same sentence.',
  '',
  'A paragraph with [an in-doc anchor](#link-fixture) and [an address](mailto:a@b.com).',
  '',
  'A plain paragraph with no links at all.',
].join('\n');

const opened = { urls: [], docs: [], toasts: [] };
const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/notes/doc.md', content: FIXTURE, mtimeMs: 1, size: FIXTURE.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitMarkdownThreads: async () => ({ success: true, data: { threads: [] } }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/runbook.md' }),
  readMarkdownThreads: async () => ({ success: true, data: { threads: [] } }),
  addMarkdownThreadMessage: async () => ({ success: true, data: { threads: [] } }),
  writeMarkdownFile: async () => ({ success: true, path: '/fake/notes/doc.md', mtimeMs: 2, size: 1 }),
  showToast: (message) => opened.toasts.push(message),
  openURL: (url) => opened.urls.push(url),
  openDocPath: (filePath) => opened.docs.push(filePath),
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
const key = (init) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, ...init }));

function linkTo(hrefFragment) {
  const link = Array.from(primary().querySelectorAll('a[href]'))
    .find((a) => (a.getAttribute('href') || '').includes(hrefFragment));
  if (!link) throw new Error(`no link matching ${hrefFragment}`);
  return link;
}

function clickLink(hrefFragment, { follow = false } = {}) {
  const link = linkTo(hrefFragment);
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: follow });
  link.dispatchEvent(event);
  return event;
}

function hintText() {
  const hint = primary().querySelector('.md-comment-hint');
  return hint ? hint.textContent : '';
}

function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .find((b) => b.textContent.includes(matchText));
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return el;
}

function selectAcross(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function clearSelection() {
  const selection = dom.window.getSelection();
  if (selection) selection.removeAllRanges();
}

function reset() {
  opened.urls.length = 0;
  opened.docs.length = 0;
  opened.toasts.length = 0;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/notes/doc.md' });
  await sleep(30);

  // --- the plain click is the comment/edit gesture, link text included ---
  reset();
  let event = clickLink('example.com');
  check('a plain click on link text follows nothing',
    opened.urls.length === 0 && opened.docs.length === 0, opened);
  check('it arms the block it sits in instead',
    !!primary().querySelector('.md-comment-target-active'));
  check('and the hint says a modifier follows', /⌘click follows/.test(hintText()), hintText());
  check('the click never reaches the app shell', event.defaultPrevented);
  key({ key: 'Escape' });
  await sleep(5);

  reset();
  clickBlock('no links at all');
  await sleep(5);
  check('the hint stays quiet on prose with no link',
    hintText() === 'letters comment · other keys edit', hintText());
  key({ key: 'Escape' });
  await sleep(5);

  // --- the modified click follows, to its two destinations ---
  reset();
  event = clickLink('example.com', { follow: true });
  check('modified click on a web link goes to the browser',
    opened.urls[0] === 'https://example.com/page', opened.urls);
  check('web link opens no doc', opened.docs.length === 0, opened.docs);
  check('web link click is swallowed', event.defaultPrevented);

  reset();
  event = clickLink('sibling.md', { follow: true });
  check('modified click on a relative link opens the doc it names, resolved next to this one',
    opened.docs[0] === '/fake/notes/sibling.md', opened.docs);
  check('relative link click is swallowed', event.defaultPrevented);

  // --- links the viewer will not follow ---
  reset();
  event = clickLink('#link-fixture', { follow: true });
  check('a fragment opens nothing', opened.urls.length === 0 && opened.docs.length === 0, opened);
  check('a fragment never reaches the app shell', event.defaultPrevented);

  reset();
  event = clickLink('mailto:', { follow: true });
  check('mailto: opens nothing', opened.urls.length === 0 && opened.docs.length === 0, opened);
  check('mailto: never reaches the app shell', event.defaultPrevented);

  // --- a selection ending on a link is a selection ---
  reset();
  selectAcross(linkTo('sibling.md'));
  clickLink('sibling.md');
  check('a live selection is not a link click', opened.docs.length === 0 && opened.urls.length === 0, opened);
  clearSelection();

  // --- inside an open editor, a link is text ---
  reset();
  clickBlock('the web');
  await sleep(5);
  key({ key: 'Backspace' }); // first key opens the rendered editor
  await sleep(10);
  check('the block is being edited', !!primary().querySelector('.md-rendered-editing'));
  const editEvents = [clickLink('example.com', { follow: true }), clickLink('sibling.md', { follow: true })];
  check('a link in the block being edited follows nothing, modifier or not',
    opened.urls.length === 0 && opened.docs.length === 0, opened);
  check('and never reaches the app shell either', editEvents.every((e) => e.defaultPrevented));
  check('the editor survives the click', !!primary().querySelector('.md-rendered-editing'));
  key({ key: 'Escape' }); // revert the edit
  await sleep(10);

  // --- unsent work outranks the link ---
  reset();
  clickBlock('no links at all');
  await sleep(5);
  key({ key: 'c' }); // a–z opens a comment card on the active block
  await sleep(10);
  check('a comment card is open', !!document.querySelector('.md-comment-card, .md-comment-composer'),
    document.body.innerHTML.slice(0, 200));
  clickLink('sibling.md', { follow: true });
  check('unsent work blocks the doc swap', opened.docs.length === 0, opened.docs);
  check('and says why', /send or discard/i.test(opened.toasts.join(' ')), opened.toasts);
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the viewer's refresh timers keep the loop alive
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
