// Guards the md viewer's ⧉ copy against the REAL src/markdown-viewer.js in
// jsdom: copy takes what's armed. Nothing armed → the whole body as plain
// text (headings out, paragraphs one-lined, top-level list items separated,
// nested items each their own line); a clicked heading → its section's body, up to
// the next heading of its level; a clicked paragraph → that paragraph; the
// modifier variant → the markdown source of the same scope; ⌘C on an armed
// block → the same copy from the keyboard. The bar button's label names the
// scope before the click and returns to "text" when the target clears.

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

// The viewer writes through the bare `navigator` global (Node's own here).
let copied = null;
let copiedHtml = null;
let richCopyFails = false;
let richWrites = 0;
dom.window.ClipboardItem = class { constructor(data) { this.data = data; } };
const writeRich = async ([item]) => {
  richWrites++;
  if (richCopyFails) throw new Error('Rich clipboard unavailable');
  copied = await item.data['text/plain'].text();
  copiedHtml = await item.data['text/html'].text();
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'MacIntel', clipboard: {
    writeText: async (t) => { copied = t; copiedHtml = null; },
    write: writeRich,
  } },
});

const { createMarkdownViewer } = require('../src/markdown-viewer');

const FIXTURE = [
  '# Title',
  '',
  'Intro paragraph that wraps',
  'onto a second source line.',
  '',
  '## Alpha',
  '',
  'Alpha body first paragraph.',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '### Alpha sub',
  '',
  'Sub body stays in the section.',
  '',
  '## Beta',
  '',
  'Beta body paragraph.',
].join('\n');
let currentSource = FIXTURE;

const noop = () => {};
const store = { version: 1, turn: 1, threads: [] };
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: currentSource, mtimeMs: 1, size: currentSource.length }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: currentSource.length }),
  submitMarkdownThreads: async () => ({ success: true, data: store }),
  preflightMarkdownRunbook: async () => ({ runbook: '/fake/agent-threads/md/user-intent.md' }),
  readMarkdownThreads: async () => ({ success: true, data: store }),
  addMarkdownThreadMessage: async () => ({ success: true, data: store }),
  writeMarkdownFile: async () => ({ success: true }),
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
const copyBtn = () => document.querySelector('.md-copy-body');
const key = (init) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

// The innermost block holding the text (an outer list item's text includes
// its nested items').
function clickBlock(matchText) {
  const el = Array.from(primary().querySelectorAll('[data-md-anchor-id]'))
    .filter((b) => b.textContent.includes(matchText))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return el;
}

async function pressCopy(init = {}) {
  copied = null;
  copiedHtml = null;
  copyBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init }));
  await sleep(10);
  return copied;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  await viewer.open({ filePath: '/fake/doc.md' });
  await sleep(30);

  check('button starts as the whole text', copyBtn().textContent === '⧉ text', copyBtn().textContent);
  {
    const text = await pressCopy();
    check('unarmed copy is the whole body, headings out, paragraphs one-lined, nested items once each',
      text === [
        'Intro paragraph that wraps onto a second source line.',
        'Alpha body first paragraph.',
        'one\nnested\n\ntwo',
        'Sub body stays in the section.',
        'Beta body paragraph.',
      ].join('\n\n'), text);
    check('the flash confirms', copyBtn().textContent === '✓', copyBtn().textContent);
  }

  // --- a clicked heading marks its section ---
  clickBlock('Alpha');
  await sleep(5);
  check('arming a heading relabels the button as the section', copyBtn()._restLabel === '⧉ section', copyBtn()._restLabel);
  {
    const text = await pressCopy();
    check('heading copy is the section body through its sub-section, stopping at the next peer heading',
      text === ['Alpha body first paragraph.', 'one\nnested\n\ntwo', 'Sub body stays in the section.'].join('\n\n'), text);
    check('the heading stays armed after the copy', !!primary().querySelector('h2.md-comment-target-active'));
  }
  {
    const text = await pressCopy({ metaKey: true });
    check('modifier copy with a heading armed is the section body source, no blank lines around it',
      text === ['Alpha body first paragraph.', '', '- one', '  - nested', '- two', '', '### Alpha sub', '', 'Sub body stays in the section.'].join('\n'), text);
  }

  // --- a sub-heading marks only its own section ---
  clickBlock('Alpha sub');
  await sleep(5);
  {
    const text = await pressCopy();
    check('sub-heading copy is just its own body', text === 'Sub body stays in the section.', text);
  }

  // --- a clicked paragraph is itself ---
  clickBlock('Beta body');
  await sleep(5);
  check('arming a paragraph relabels the button', copyBtn()._restLabel === '⧉ paragraph', copyBtn()._restLabel);
  {
    const text = await pressCopy();
    check('paragraph copy is that paragraph', text === 'Beta body paragraph.', text);
  }

  // --- a nested list item is lifted to column 0 for the source variant ---
  clickBlock('nested');
  await sleep(5);
  check('a list item labels as an item', copyBtn()._restLabel === '⧉ item', copyBtn()._restLabel);
  {
    const text = await pressCopy({ metaKey: true });
    check('nested item source copies dedented', text === '- nested', text);
  }

  // --- ⌘C on an armed block is the keyboard twin ---
  const intro = clickBlock('Intro paragraph');
  await sleep(5);
  copied = null;
  {
    // Arming focuses the viewer shell, so the chord lands inside it.
    const ev = new dom.window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
    intro.dispatchEvent(ev);
    await sleep(10);
    check('⌘C with a paragraph armed copies it', copied === 'Intro paragraph that wraps onto a second source line.', copied);
    check('⌘C is consumed', ev.defaultPrevented);
  }

  // --- the letters still comment on an armed heading (no collision) ---
  clickBlock('Beta');
  await sleep(5);
  key({ key: 'n' });
  await sleep(10);
  {
    const ta = document.querySelector('.md-comment-card textarea, textarea.cu-ta');
    check('a letter on an armed heading still opens the comment composer', !!ta && ta.value === 'n', ta && ta.value);
    if (ta) ta.value = '';
  }
  key({ key: 'Escape' });
  await sleep(10);
  check('clearing the target returns the button to the whole text', copyBtn()._restLabel === '⧉ text', copyBtn()._restLabel);

  // Message links must survive both clipboard flavors, including scoped copy.
  currentSource = [
    '# Message', '', 'Introduction outside the draft.', '', '## Draft', '',
    'See [Support & <draft>](https://example.test/support?lab=orion&scope=pm) and [Bellevue Team](https://example.test/bellevue).', '',
    'Contact <owner@example.test>, visit <https://example.test/status> or www.example.com.', '',
    '1. Orion: **restore** the host.',
    '   - Keep [exports](https://example.test/export).',
    '2. Phoenix: `add` NR exports.', '',
    '```text', '  [literal](https://example.test/code)', 'second line', '```', '',
    '## Notes', '', 'Private notes outside the draft.',
  ].join('\n');
  viewer.close();
  await viewer.open({ filePath: '/fake/message.md' });
  await sleep(30);
  clickBlock('Draft');
  const expectedDraft = [
    'See Support & <draft> (https://example.test/support?lab=orion&scope=pm) and Bellevue Team (https://example.test/bellevue).',
    'Contact owner@example.test, visit https://example.test/status or www.example.com.',
    '1. Orion: restore the host.\nKeep exports (https://example.test/export).',
    '2. Phoenix: add NR exports.',
    '  [literal](https://example.test/code)\nsecond line',
  ].join('\n\n');
  {
    const text = await pressCopy();
    check('plain-text copy retains named URLs, list numbers, blank lines, and literal code', text === expectedDraft, text);
    const html = document.createElement('div');
    html.innerHTML = copiedHtml;
    const links = Array.from(html.querySelectorAll('a')).map((link) => [link.textContent, link.getAttribute('href')]);
    check('rich copy retains clickable titles, including escaped characters and URL queries',
      JSON.stringify(links) === JSON.stringify([
        ['Support & <draft>', 'https://example.test/support?lab=orion&scope=pm'],
        ['Bellevue Team', 'https://example.test/bellevue'],
        ['owner@example.test', 'mailto:owner@example.test'],
        ['https://example.test/status', 'https://example.test/status'],
        ['www.example.com', 'http://www.example.com'],
        ['exports', 'https://example.test/export'],
      ]), links);
    check('rich copy has separate paragraphs for the two numbered options',
      Array.from(html.querySelectorAll('p')).some((p) => p.textContent.startsWith('1. Orion:'))
      && Array.from(html.querySelectorAll('p')).some((p) => p.textContent === '2. Phoenix: add NR exports.'), copiedHtml);
    check('rich copy excludes headings, outside notes, and typography',
      !html.querySelector('h1, h2, strong, em, code, draft, [data-md-anchor-id]')
      && !html.textContent.includes('outside the draft'), copiedHtml);
    check('rich code keeps whitespace and literal markup',
      html.querySelector('[style]').textContent === '  [literal](https://example.test/code)\nsecond line', copiedHtml);
  }
  {
    const text = await pressCopy({ metaKey: true });
    const draftSource = currentSource.split('## Draft\n\n')[1].split('\n\n## Notes')[0];
    check('modifier copy preserves source and clears the rich flavor', text === draftSource && copiedHtml === null, text);
  }
  {
    richCopyFails = true;
    check('a rejected rich write falls back to text with URLs and blank lines', await pressCopy() === expectedDraft && copiedHtml === null, copied);
    richCopyFails = false;
    const itemClass = dom.window.ClipboardItem;
    delete dom.window.ClipboardItem;
    check('hosts without ClipboardItem still copy URLs and blank lines', await pressCopy() === expectedDraft && copiedHtml === null, copied);
    dom.window.ClipboardItem = itemClass;
    delete navigator.clipboard.write;
    check('hosts without clipboard.write still copy URLs and blank lines', await pressCopy() === expectedDraft && copiedHtml === null, copied);
    navigator.clipboard.write = writeRich;
  }
  {
    const paragraph = clickBlock('See Support');
    copied = null;
    copiedHtml = null;
    paragraph.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }));
    await sleep(10);
    check('keyboard paragraph copy also retains both link flavors', copied === expectedDraft.split('\n\n')[0]
      && (copiedHtml.match(/<a /g) || []).length === 2, copied);
  }

  currentSource = '7. First\n\n   3. Nested first\n   4. Nested second\n8. Second';
  viewer.close();
  await viewer.open({ filePath: '/fake/numbered.md' });
  await sleep(30);
  {
    const before = richWrites;
    const text = await pressCopy();
    check('ordered lists preserve start numbers and nested numbering with blank lines between top-level items',
      text === '7. First\n3. Nested first\n4. Nested second\n\n8. Second', text);
    check('messages without links keep using the plain clipboard', richWrites === before && copiedHtml === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
