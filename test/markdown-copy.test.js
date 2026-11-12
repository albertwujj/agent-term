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
const key = (init, type = 'keydown') => document.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));

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
  const messageTitle = copyBtn().title;
  for (const [name, flag] of [['Control', 'ctrlKey'], ['Meta', 'metaKey'], ['Alt', 'altKey']]) {
    const event = new dom.window.KeyboardEvent('keydown', { key: name, [flag]: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    check(`${name} previews Markdown in the visible label and tooltip`,
      copyBtn().textContent === '⧉ text · md' && copyBtn().title.startsWith('Copy as Markdown:'), copyBtn().textContent);
    check(`${name} preview leaves the key available to the app`, !event.defaultPrevented);
    key({ key: name }, 'keyup');
    check(`${name} release restores the normal copy label and tooltip`,
      copyBtn().textContent === '⧉ text' && copyBtn().title === messageTitle, copyBtn().textContent);
  }
  {
    key({ key: 'Control', ctrlKey: true });
    key({ key: 'Alt', ctrlKey: true, altKey: true });
    key({ key: 'Control', altKey: true }, 'keyup');
    check('releasing one modifier keeps Markdown preview while another is held', copyBtn().textContent === '⧉ text · md');
    window.dispatchEvent(new dom.window.Event('blur'));
    check('losing window focus resets the preview without a keyup', copyBtn().textContent === '⧉ text' && copyBtn().title === messageTitle);
    copyBtn().dispatchEvent(new dom.window.PointerEvent('pointerenter', { ctrlKey: true }));
    check('hover recovers a modifier held before focus returned', copyBtn().textContent === '⧉ text · md');
    copyBtn().dispatchEvent(new dom.window.PointerEvent('pointermove'));
    check('pointer movement clears a stale modifier', copyBtn().textContent === '⧉ text');
  }
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
    key({ key: 'Control', ctrlKey: true });
    check('the tooltip updates during a copy confirmation', copyBtn().title.startsWith('Copy as Markdown:'));
    await sleep(1450);
    check('the confirmation ends on the current Markdown preview', copyBtn().textContent === '⧉ text · md', copyBtn().textContent);
    key({ key: 'Control' }, 'keyup');
  }

  // --- a clicked heading marks its section ---
  clickBlock('Alpha');
  await sleep(5);
  check('arming a heading relabels the button as the section', copyBtn()._restLabel === '⧉ section', copyBtn()._restLabel);
  key({ key: 'Control', ctrlKey: true });
  check('Markdown preview retains the armed section scope',
    copyBtn().textContent === '⧉ section · md' && copyBtn().title.includes('the section'), copyBtn().textContent);
  key({ key: 'Control' }, 'keyup');
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

  const tableSource = [
    '| Lab | Host | Status |', '| --- | --- | --- |',
    '| **Orion** | `host-a` | [Unreachable & <check>](https://example.test/status?a=1&b=2) |',
    '| Phoenix | host-b | Needs<br>NR exports |',
  ].join('\n');
  currentSource = `# Message\n\nIntro.\n\n## Draft\n\nBefore the table.\n\n${tableSource}\n\nAfter the table.\n\n## Notes\n\nPrivate notes.`;
  viewer.close();
  await viewer.open({ filePath: '/fake/table.md' });
  await sleep(30);
  const tableText = 'Lab: Orion\nHost: host-a\nStatus: Unreachable & <check> (https://example.test/status?a=1&b=2)'
    + '\n\nLab: Phoenix\nHost: host-b\nStatus: Needs NR exports';
  {
    const text = await pressCopy();
    check('document copy keeps table rows between the surrounding paragraphs',
      text === ['Intro.', 'Before the table.', tableText, 'After the table.', 'Private notes.'].join('\n\n'), text);
  }
  clickBlock('Draft');
  {
    const text = await pressCopy();
    check('section copy keeps table rows and excludes the next section',
      text === ['Before the table.', tableText, 'After the table.'].join('\n\n'), text);
  }
  clickBlock('Orion');
  check('clicking a table scopes copy to that table', copyBtn()._restLabel === '⧉ table', copyBtn()._restLabel);
  {
    const text = await pressCopy();
    check('plain table copy repeats headers as labels and separates records with a blank line', text === tableText, text);
    const html = document.createElement('div');
    html.innerHTML = copiedHtml;
    const rows = Array.from(html.querySelectorAll('tr')).map((row) => Array.from(row.cells).map((cell) => cell.textContent));
    check('rich table copy preserves headers, cells, and row boundaries', JSON.stringify(rows) === JSON.stringify([
      ['Lab', 'Host', 'Status'], ['Orion', 'host-a', 'Unreachable & <check>'], ['Phoenix', 'host-b', 'Needs NR exports'],
    ]), rows);
    check('rich table copy keeps clickable cell links and escapes literal markup',
      html.querySelector('td a').getAttribute('href') === 'https://example.test/status?a=1&b=2'
      && !html.querySelector('check, strong, code, [data-md-anchor-id]'), copiedHtml);
  }
  {
    check('table source copy stays verbatim', await pressCopy({ metaKey: true }) === tableSource && copiedHtml === null, copied);
    richCopyFails = true;
    check('a rejected rich table write keeps labeled rows in the fallback', await pressCopy() === tableText && copiedHtml === null, copied);
    richCopyFails = false;
  }
  currentSource = '| | Status |\n| --- | --- |\n| Orion | Up |\n| Phoenix | |';
  viewer.close();
  await viewer.open({ filePath: '/fake/unlinked-table.md' });
  await sleep(30);
  {
    const text = await pressCopy();
    check('blank headers get numbered labels and empty cells retain their label',
      text === 'Column 1: Orion\nStatus: Up\n\nColumn 1: Phoenix\nStatus:', text);
    check('a table without links still offers an HTML table', copiedHtml && copiedHtml.includes('<table'), copiedHtml);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
