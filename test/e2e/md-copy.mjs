// Real Chromium clipboard round trip: a rich editor receives the doc's
// structure (headings, emphasis, real lists, tables, clickable links), while a
// textarea receives message text: URLs written out, the list's numbers and
// blank lines, and tables as labeled rows. A selection keeps its formatting.
// A clicked image copies its pixels, even when it shares a block with another.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { launchElectron, CHECKOUT_DIR } from './electron.mjs';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-md-copy-'));
const wideImage = path.join(tmp, 'wide.svg');
const smallImage = path.join(tmp, 'small.svg');
const imageBlock = '![Wide diagram](wide.svg) ![Small diagram](small.svg)';
const delayedImageUrl = 'https://example.test/delayed-layout.svg';
const imageLayoutSource = [
  '# Image layout', '', `![A delayed image](${delayedImageUrl})`, '',
  ...Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}. A line for testing the reading position.\n`),
].join('\n');
const source = [
  '# Message', '', 'Introduction outside the draft.', '', '## Draft', '',
  'See [Support & lab](https://example.test/support?lab=orion&scope=pm).', '',
  '1. Orion: **restore** the host.', '2. Phoenix: add NR exports.', '',
  '| Lab | Host | Status |', '| --- | --- | --- |',
  '| Orion | host-a | Unreachable |', '| Phoenix | host-b | NR exports missing |', '',
  '## Notes', '', 'Private notes outside the draft.', '', imageBlock,
].join('\n');
const tableExpected = 'Lab: Orion\nHost: host-a\nStatus: Unreachable'
  + '\n\nLab: Phoenix\nHost: host-b\nStatus: NR exports missing';
const expected = 'See Support & lab (https://example.test/support?lab=orion&scope=pm).'
  + '\n\n1. Orion: restore the host.\n\n2. Phoenix: add NR exports.\n\n' + tableExpected;

let app;
try {
  fs.writeFileSync(wideImage, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="120"><rect width="800" height="120" fill="blue"/></svg>');
  fs.writeFileSync(smallImage, '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="60"><rect width="90" height="60" fill="red"/></svg>');
  await build({
    entryPoints: [path.join(CHECKOUT_DIR, 'src/markdown-viewer.js')],
    bundle: true, format: 'iife', globalName: 'MarkdownViewer',
    outfile: path.join(tmp, 'viewer.js'),
  });
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><html><body><script src="viewer.js"></script></body></html>');
  fs.writeFileSync(path.join(tmp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(() => {
      const win = new BrowserWindow({ width: 1200, height: 900 });
      win.loadFile(require('node:path').join(__dirname, 'index.html'));
    });
    app.on('window-all-closed', () => app.quit());
  `);
  app = await launchElectron({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(tmp, 'main.cjs')], timeout: 45_000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.MarkdownViewer);
  await page.evaluate(async ({ source, docPath, imageLayoutSource }) => {
    const noop = () => {};
    const sourceFor = (file) => file === '/image-layout.md' ? imageLayoutSource : source;
    window.viewer = MarkdownViewer.createMarkdownViewer({
      readMarkdownFile: async (file) => ({
        success: true, path: file === '/image-layout.md' ? file : docPath,
        imageRoot: 'file://', content: sourceFor(file), mtimeMs: 1, size: sourceFor(file).length,
      }),
      statMarkdownFile: async (file) => ({ success: true, mtimeMs: 1, size: sourceFor(file).length }),
      readMarkdownThreads: async () => ({ success: true, data: { threads: [] } }),
      preflightMarkdownRunbook: async () => ({ runbook: '/stub/user-intent.md' }),
      showToast: noop, openURL: noop, focusTerminal: noop, onClose: noop,
      getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
      platform: 'linux',
    });
    await window.viewer.open({ filePath: '/copy-test.md' });
  }, { source, docPath: path.join(tmp, 'copy-test.md'), imageLayoutSource });
  const copyButton = page.locator('.md-copy-body');
  await copyButton.hover();
  const messageTitle = await copyButton.getAttribute('title');
  // The pointer stays over the button while Control goes down and back up.
  await page.keyboard.down('Control');
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ text · md');
  assert.ok((await copyButton.getAttribute('title')).startsWith('Copy as Markdown:'));
  await page.keyboard.up('Control');
  assert.equal(await copyButton.textContent(), '⧉ text');
  assert.equal(await copyButton.getAttribute('title'), messageTitle);
  console.log('PASS Control updates the label and tooltip while the pointer is already over copy');

  await page.mouse.move(10, 10);
  await page.keyboard.down('Control');
  await copyButton.hover();
  assert.equal(await copyButton.textContent(), '⧉ text · md');
  await page.keyboard.up('Control');
  assert.equal(await copyButton.textContent(), '⧉ text');
  console.log('PASS holding Control before hovering also previews Markdown');

  const heading = page.locator('.md-viewer-body h2').filter({ hasText: 'Draft' });
  await heading.first().click();
  await copyButton.hover();
  await page.keyboard.down('Control');
  assert.equal(await copyButton.textContent(), '⧉ section · md');
  assert.ok((await copyButton.getAttribute('title')).includes('the section'));
  await page.keyboard.up('Control');
  await page.locator('.md-copy-body').click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  const clipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.equal(clipboard.text, expected);
  assert.ok(clipboard.html.includes('https://example.test/support?lab=orion&amp;scope=pm'));
  assert.ok(clipboard.html.includes('<strong>restore</strong>'), clipboard.html);
  assert.ok(!/<h[1-6]|class=|data-md-/.test(clipboard.html), clipboard.html);

  // Close the viewer and paste into ordinary browser fields using native paste.
  await page.evaluate(() => {
    window.viewer.close();
    document.body.insertAdjacentHTML('beforeend', '<textarea id="plain"></textarea><div id="rich" contenteditable="true"></div>');
  });
  const paste = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
  await page.locator('#plain').focus();
  await page.keyboard.press(paste);
  assert.equal(await page.locator('#plain').inputValue(), expected);
  console.log('PASS plain paste retains URLs, list numbers, blank lines, and labeled table rows');

  await page.locator('#rich').focus();
  await page.keyboard.press(paste);
  const rich = await page.locator('#rich').evaluate((el) => ({
    text: el.innerText,
    paragraphs: Array.from(el.querySelectorAll('p')).map((p) => p.textContent),
    items: Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent),
    boldWeight: Array.from(el.querySelectorAll('ol > li *')).filter((node) => node.textContent === 'restore')
      .map((node) => Number(getComputedStyle(node).fontWeight)).some((weight) => weight >= 600),
    links: Array.from(el.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')]),
    rows: Array.from(el.querySelectorAll('tr')).map((row) => Array.from(row.cells).map((cell) => cell.textContent)),
  }));
  assert.deepEqual(rich.links, [['Support & lab', 'https://example.test/support?lab=orion&scope=pm']]);
  assert.deepEqual(rich.paragraphs, ['See Support & lab.']);
  assert.deepEqual(rich.items, ['Orion: restore the host.', 'Phoenix: add NR exports.']);
  assert.equal(rich.boldWeight, true);
  assert.deepEqual(rich.rows, [
    ['Lab', 'Host', 'Status'], ['Orion', 'host-a', 'Unreachable'], ['Phoenix', 'host-b', 'NR exports missing'],
  ]);
  console.log('PASS rich paste retains clickable titles, a real numbered list with its bold, and a real table');

  // Copying only the table must offer HTML even though no cell contains a link.
  await page.evaluate(() => window.viewer.open({ filePath: '/copy-test.md' }));
  const expandTable = page.getByRole('button', { name: 'Expand table', exact: true });
  assert.equal(await expandTable.count(), 0);
  await page.locator('.md-viewer-body table').first().click();
  // Wait out the preceding copy's success flash before waiting for this copy.
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ table');
  await page.locator('.md-copy-body').click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  const tableOnly = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.equal(tableOnly.text, tableExpected);
  assert.ok(tableOnly.html.includes('<table'));
  console.log('PASS a table without links copies as HTML with labeled plain-text rows');

  const titleBar = page.locator('.vb-shell.vb-md .vb-title');
  const titleBeforeExpand = await titleBar.textContent();
  await expandTable.click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('md-table-inspector'));
  const expandedTable = page.getByRole('dialog', { name: 'Expanded table' });
  assert.deepEqual(await expandedTable.locator('th').allTextContents(), ['Lab', 'Host', 'Status']);
  assert.equal(await expandedTable.locator('tbody tr').count(), 2);
  const tableFits = await expandedTable.getByRole('region', { name: 'Table contents' })
    .evaluate((el) => el.scrollWidth <= el.clientWidth);
  assert.equal(tableFits, true);
  await page.keyboard.press('Escape');
  await expandedTable.waitFor({ state: 'detached' });
  assert.equal(await titleBar.textContent(), titleBeforeExpand);
  assert.equal(await expandTable.evaluate((button) => button === document.activeElement), true);
  console.log('PASS expanding a table fits the same columns and returns focus to the selected table');

  const bodyWord = await page.locator('.md-viewer-body td').filter({ hasText: 'Unreachable' }).first().evaluate((cell) => {
    const range = new Range();
    range.selectNodeContents(cell);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.dblclick(bodyWord.x, bodyWord.y);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Unreachable');
  assert.equal(await expandedTable.count(), 0);

  await page.locator('.md-viewer-body thead th').filter({ hasText: 'Lab' }).first().dblclick();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('md-table-inspector'));
  await expandedTable.getByRole('button', { name: 'Close' }).click();
  await expandedTable.waitFor({ state: 'detached' });
  assert.equal(await expandTable.isVisible(), true);
  console.log('PASS double-clicking a table header expands it and body text keeps native selection');

  // A source copy replaces the rich clipboard, rather than leaving stale HTML.
  await page.evaluate(() => window.viewer.open({ filePath: '/copy-test.md' }));
  await heading.first().click();
  await page.locator('.md-copy-body').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓ md');
  // The formats, not readHTML(): on macOS readHTML() hands back the plain
  // text when the clipboard holds text alone.
  const raw = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), formats: clipboard.availableFormats() }));
  assert.equal(raw.text, source.split('## Draft\n\n')[1].split('\n\n## Notes')[0]);
  assert.ok(!raw.formats.includes('text/html'), raw.formats.join(', '));
  console.log('PASS markdown source copy replaces both clipboard flavors');

  // The whole document, with nothing armed: headings arrive only in the rich flavor.
  await page.evaluate(() => window.viewer.open({ filePath: '/copy-test.md' }));
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ text');
  await copyButton.click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  const whole = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.ok(whole.text.startsWith('Introduction outside the draft.\n\nSee Support & lab'), whole.text);
  assert.ok(/<h1[^>]*>Message<\/h1>/.test(whole.html) && /<h2[^>]*>Draft<\/h2>/.test(whole.html), whole.html);
  assert.ok(/<ol[^>]*>\s*<li/.test(whole.html) && !whole.html.includes('<img'), whole.html);
  console.log('PASS whole-document copy is rich with headings and lists, and plain without headings');

  const boldWord = await page.waitForFunction(() => {
    for (const strong of document.querySelectorAll('.md-viewer-body strong')) {
      const rect = strong.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (document.elementFromPoint(x, y) === strong) return { x, y };
    }
  });
  const boldAt = await boldWord.jsonValue();
  await page.mouse.dblclick(boldAt.x, boldAt.y);
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ selection');
  await copyButton.click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  const picked = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.equal(picked.text, 'restore');
  assert.ok(picked.html.includes('<strong>restore</strong>'), picked.html);
  console.log('PASS a selection copies with the formatting it sat in');
  // Leave no selection behind: the next click must arm what it lands on.
  await page.evaluate(() => {
    window.getSelection().removeAllRanges();
    return window.viewer.open({ filePath: '/copy-test.md' });
  });
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ text');

  const imagePoint = async (alt) => {
    // Both panes render the block. Click the image where the pane exposes it.
    const point = await page.waitForFunction((alt) => {
      for (const image of document.querySelectorAll('.md-viewer-body img')) {
        if (image.alt !== alt || !image.naturalWidth) continue;
        const rect = image.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (document.elementFromPoint(x, y) === image) return { x, y };
      }
    }, alt);
    return point.jsonValue();
  };
  const clickImage = async (alt) => {
    const { x, y } = await imagePoint(alt);
    await page.mouse.click(x, y);
    assert.equal(await copyButton.textContent(), '⧉ image');
    assert.equal(await page.locator('img.md-copy-image').getAttribute('alt'), alt);
  };
  const clipboardImageSize = () => app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
  await clickImage('Wide diagram');
  await copyButton.click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  assert.deepEqual(await clipboardImageSize(), { width: 800, height: 120 });
  console.log('PASS image copy uses intrinsic size even when an image is scaled down');

  await clickImage('Small diagram');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  assert.deepEqual(await clipboardImageSize(), { width: 90, height: 60 });
  console.log('PASS keyboard copy takes the exact image clicked in a shared block');

  await copyButton.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓ md');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), imageBlock);
  console.log('PASS modifier-copy writes the containing block source');

  const expanded = page.getByRole('dialog', { name: 'Expanded image' });
  const { x, y } = await imagePoint('Wide diagram');
  await page.mouse.dblclick(x, y);
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('md-image-inspector'));
  assert.equal(await expanded.locator('img').getAttribute('alt'), 'Wide diagram');
  const stage = expanded.locator('.md-image-stage');
  const { frame, image } = await stage.evaluate((el) => ({
    frame: el.getBoundingClientRect().toJSON(),
    image: el.querySelector('img').getBoundingClientRect().toJSON(),
  }));
  assert.ok(image.left >= frame.left - 1 && image.right <= frame.right + 1);
  assert.ok(image.top >= frame.top - 1 && image.bottom <= frame.bottom + 1);
  assert.ok(Math.min(frame.width - image.width, frame.height - image.height) < 1);
  const level = expanded.getByLabel('Zoom level');
  const fit = parseInt(await level.textContent(), 10);
  await stage.dblclick();
  assert.ok(parseInt(await level.textContent(), 10) > fit);
  const panX = frame.x + frame.width / 2;
  const panY = frame.y + frame.height / 2;
  const imageLeft = () => stage.locator('img').evaluate((el) => el.getBoundingClientRect().left);
  const beforePan = await imageLeft();
  await page.mouse.move(panX, panY);
  await page.mouse.down();
  await page.mouse.move(panX + 100, panY, { steps: 24 });
  await page.mouse.up();
  assert.ok(Math.abs(await imageLeft() - beforePan - 100) < 1, 'panning follows the entire drag');
  await page.keyboard.press('Escape');
  await expanded.waitFor({ state: 'detached' });
  assert.equal(await page.locator('img.md-copy-image').getAttribute('alt'), 'Wide diagram');
  assert.equal(await page.locator('.vb-shell.vb-md').evaluate((el) => el === document.activeElement), true);
  console.log('PASS double-click fits the exact image, zooms further, and Escape returns to its selection');

  // Let the user turn the page before the image above it gets its dimensions.
  let releaseImage;
  const imageReady = new Promise((resolve) => { releaseImage = resolve; });
  await page.route(delayedImageUrl, async (route) => {
    await imageReady;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="440"><rect width="400" height="440" fill="blue"/></svg>',
    });
  });
  await page.evaluate(() => window.viewer.open({ filePath: '/image-layout.md' }));
  await page.getByRole('heading', { name: 'Image layout' }).first().waitFor();
  const pane = page.locator('.vb-md.open .primary .md-page-viewport');
  const paneBox = await pane.boundingBox();
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelector('.vb-md.open .primary .md-page-viewport').scrollTop > 100);
  const visibleParagraphs = () => page.locator('.vb-md.open .md-page-viewport').evaluateAll((panes) => panes.map((el) => {
    const { top } = el.getBoundingClientRect();
    const paragraph = [...el.querySelectorAll('p')].find((p) => p.getBoundingClientRect().bottom > top + 1);
    return { text: paragraph.textContent, offset: paragraph.getBoundingClientRect().top - top };
  }));
  const beforeImage = await visibleParagraphs();
  assert.ok(beforeImage.every(({ text }) => text.startsWith('Paragraph ')));
  releaseImage();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.vb-md.open .md-viewer-body img')];
    return images.length === 2 && images.every((img) => img.naturalHeight && img.getBoundingClientRect().height > 200);
  });
  const afterImage = await visibleParagraphs();
  assert.deepEqual(afterImage.map(({ text }) => text), beforeImage.map(({ text }) => text));
  assert.ok(afterImage.every(({ offset }, i) => Math.abs(offset - beforeImage[i].offset) <= 2));
  console.log('PASS a delayed image keeps the same text on both pages after a wheel turn');
  assert.deepEqual(errors, []);
} finally {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
