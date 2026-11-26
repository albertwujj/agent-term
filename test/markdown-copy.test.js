// Guards the md viewer's ⧉ copy against the REAL src/markdown-viewer.js in
// jsdom: copy takes what's armed, in two flavors. Plain: nothing armed → the
// whole body as message text (headings out, paragraphs one-lined, top-level
// list items separated, nested items each their own line); a clicked heading →
// its section's body, up to the next heading of its level; a clicked paragraph
// → that paragraph. Rich: the same scope with its structure (headings,
// emphasis, lists, code, tables, links), and a selection cut from the rendered
// article. The modifier variant → the markdown source of the same scope, text
// only; ⌘C on an armed block → the same copy from the keyboard. The bar
// button's label names the scope before the click and returns to "text" when
// the target clears.

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
const copyLabel = () => copyBtn().getAttribute('aria-label');
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
  check('arming a heading relabels the button as the section', copyLabel() === 'Copy section', copyLabel());
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
  check('arming a paragraph relabels the button', copyLabel() === 'Copy paragraph', copyLabel());
  {
    const text = await pressCopy();
    check('paragraph copy is that paragraph', text === 'Beta body paragraph.', text);
  }

  // --- a nested list item is lifted to column 0 for the source variant ---
  clickBlock('nested');
  await sleep(5);
  check('a list item labels as an item', copyLabel() === 'Copy item', copyLabel());
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
  check('clearing the target returns the button to the whole text', copyLabel() === 'Copy text', copyLabel());

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
    const options = html.querySelectorAll('ol > li');
    check('rich copy keeps the numbered options as a real list with its nested item',
      options.length === 2 && options[0].querySelector('ul > li').textContent === 'Keep exports.'
      && options[1].textContent === 'Phoenix: add NR exports.', copiedHtml);
    check('rich copy keeps emphasis and inline code, the code in a font the destination has',
      html.querySelector('ol strong').textContent === 'restore'
      && /font-family:[^;"]*monospace/.test(html.querySelector('ol code').getAttribute('style')), copiedHtml);
    check('rich section copy excludes the outside notes and every viewer attribute',
      !html.querySelector('h1, h2, draft, [class], [id], [data-md-anchor-id], [data-source-start-line]')
      && !html.textContent.includes('outside the draft'), copiedHtml);
    check('rich code keeps whitespace and literal markup',
      html.querySelector('pre').textContent.replace(/\n$/, '') === '  [literal](https://example.test/code)\nsecond line'
      && /white-space:pre-wrap/.test(html.querySelector('pre').getAttribute('style'))
      && !html.querySelector('pre a, pre code'), copiedHtml);
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
    const html = document.createElement('div');
    html.innerHTML = copiedHtml || '';
    const lists = Array.from(html.querySelectorAll('ol')).map((ol) => [ol.getAttribute('start'), ol.children.length]);
    check('a message without links or tables is rich too, its lists numbered from their own starts',
      richWrites === before + 1 && JSON.stringify(lists) === JSON.stringify([['7', 2], ['3', 2]]), copiedHtml);
  }
  {
    // A selection is cut from the rendered article: it keeps the list it sat
    // in, numbered from the item it starts on.
    const items = Array.from(primary().querySelectorAll('ol ol > li'));
    const range = document.createRange();
    range.setStart(items[1].firstChild, 0);
    range.setEnd(items[1].firstChild, 'Nested'.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    items[1].dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(20);
    await pressCopy();
    check('a phrase selected inside a list item pastes as the phrase', copied === 'Nested' && copiedHtml === 'Nested', copiedHtml);
    const second = document.createTreeWalker(primary().querySelectorAll('ol')[0].children[1], 4);
    let last = second.nextNode();
    while (last && !last.nodeValue.trim()) last = second.nextNode();
    range.setStart(items[1].firstChild, 0);
    range.setEnd(last, 'Second'.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    items[1].dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(20);
    const text = await pressCopy();
    check('a selection copies as its text', copyLabel() === 'Copy selection' && text.replace(/\s+/g, ' ') === 'Nested second Second', [copyLabel(), text]);
    const html = document.createElement('div');
    html.innerHTML = copiedHtml || '';
    const lists = Array.from(html.querySelectorAll('ol')).map((ol) => [ol.getAttribute('start'), ol.textContent.replace(/\s+/g, ' ').trim()]);
    check('a selection across list items pastes as lists numbered from where it starts',
      JSON.stringify(lists) === JSON.stringify([['7', 'Nested second Second'], ['4', 'Nested second']])
      && html.querySelectorAll('li').length === 3
      && html.querySelector('ol > li > ol > li').textContent === 'Nested second', copiedHtml);
    window.getSelection().removeAllRanges();
    key({ key: 'Escape' });
    await sleep(10);
  }

  currentSource = [
    '# Report', '', 'Lead with **bold**, *italic*, `code` and a [site](https://example.test/a).', '',
    '## Steps', '', '- [See below](#steps)', '- ![chart](chart.png)', '', '![chart](chart.png)', '',
    '> Quoted line.', '', '---', '', 'Closing words.',
  ].join('\n');
  viewer.close();
  await viewer.open({ filePath: '/fake/report.md' });
  await sleep(30);
  {
    const text = await pressCopy();
    check('whole-document plain copy still drops headings and rules',
      text === ['Lead with bold, italic, code and a site (https://example.test/a).', 'See below (#steps)', 'Quoted line.', 'Closing words.'].join('\n\n'), text);
    const html = document.createElement('div');
    html.innerHTML = copiedHtml || '';
    check('whole-document rich copy keeps headings, emphasis, quotes and rules',
      html.querySelector('h1').textContent === 'Report' && html.querySelector('h2').textContent === 'Steps'
      && html.querySelector('p strong').textContent === 'bold' && html.querySelector('p em').textContent === 'italic'
      && html.querySelector('blockquote').textContent.trim() === 'Quoted line.' && !!html.querySelector('hr'), copiedHtml);
    check('rich copy leaves out images, the blocks they emptied, and links that only work in the viewer',
      !html.querySelector('img') && html.querySelectorAll('a').length === 1
      && html.querySelectorAll('li').length === 1 && html.querySelector('li').textContent === 'See below'
      && Array.from(html.querySelectorAll('p')).every((p) => p.textContent.trim()), copiedHtml);
  }
  {
    const strong = primary().querySelector('p strong');
    const range = document.createRange();
    range.setStart(strong.firstChild, 0);
    range.setEnd(strong.firstChild, 4);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    strong.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(20);
    const text = await pressCopy();
    check('a selection inside bold text pastes bold', text === 'bold' && copiedHtml === '<strong>bold</strong>', [text, copiedHtml]);
    const lead = primary().querySelector('p');
    const wide = document.createRange();
    wide.setStart(lead.firstChild, 'Lead '.length);
    // Ends mid-word in "Steps": a prose selection covers whole words.
    wide.setEnd(primary().querySelector('h2').firstChild, 'Step'.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(wide);
    lead.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    await sleep(20);
    await pressCopy();
    const html = document.createElement('div');
    html.innerHTML = copiedHtml || '';
    check('a selection across blocks keeps each block and its formatting',
      html.querySelector('p').textContent === 'with bold, italic, code and a site.'
      && html.querySelector('p a').getAttribute('href') === 'https://example.test/a'
      && html.querySelector('h2').textContent === 'Steps' && !html.querySelector('[class], [data-md-anchor-id]'), copiedHtml);
    window.getSelection().removeAllRanges();
    key({ key: 'Escape' });
    await sleep(10);
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
  check('clicking a table scopes copy to that table', copyLabel() === 'Copy table', copyLabel());
  {
    const text = await pressCopy();
    check('plain table copy repeats headers as labels and separates records with a blank line', text === tableText, text);
    const html = document.createElement('div');
    html.innerHTML = copiedHtml;
    const rows = Array.from(html.querySelectorAll('tr'))
      .map((row) => Array.from(row.cells).map((cell) => cell.textContent.replace(/\s+/g, ' ')));
    check('rich table copy preserves headers, cells, and row boundaries', JSON.stringify(rows) === JSON.stringify([
      ['Lab', 'Host', 'Status'], ['Orion', 'host-a', 'Unreachable & <check>'], ['Phoenix', 'host-b', 'Needs NR exports'],
    ]), rows);
    check('rich table copy keeps clickable cell links, cell formatting and line breaks, and escapes literal markup',
      html.querySelector('td a').getAttribute('href') === 'https://example.test/status?a=1&b=2'
      && html.querySelector('td strong').textContent === 'Orion' && !!html.querySelector('td br')
      && !html.querySelector('check, [class], [data-md-anchor-id]'), copiedHtml);
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
