// Real Chromium clipboard round trip: a named link stays clickable in a rich
// editor, while a textarea receives its URL and the list's numbers/blank lines.
// Tables stay tables in the rich editor and become labeled rows in the textarea.
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
const source = [
  '# Message', '', 'Introduction outside the draft.', '', '## Draft', '',
  'See [Support & lab](https://example.test/support?lab=orion&scope=pm).', '',
  '1. Orion: restore the host.', '2. Phoenix: add NR exports.', '',
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
  await page.evaluate(async ({ source, docPath }) => {
    const noop = () => {};
    window.viewer = MarkdownViewer.createMarkdownViewer({
      readMarkdownFile: async () => ({
        success: true, path: docPath, imageRoot: 'file://', content: source, mtimeMs: 1, size: source.length,
      }),
      statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: source.length }),
      readMarkdownThreads: async () => ({ success: true, data: { threads: [] } }),
      preflightMarkdownRunbook: async () => ({ runbook: '/stub/user-intent.md' }),
      showToast: noop, openURL: noop, focusTerminal: noop, onClose: noop,
      getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
      platform: 'linux',
    });
    await window.viewer.open({ filePath: '/copy-test.md' });
  }, { source, docPath: path.join(tmp, 'copy-test.md') });
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
    links: Array.from(el.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')]),
    rows: Array.from(el.querySelectorAll('tr')).map((row) => Array.from(row.cells).map((cell) => cell.textContent)),
  }));
  assert.deepEqual(rich.links, [['Support & lab', 'https://example.test/support?lab=orion&scope=pm']]);
  assert.ok(rich.text.startsWith('See Support & lab.\n\n1. Orion: restore the host.\n\n2. Phoenix: add NR exports.'));
  assert.deepEqual(rich.paragraphs, ['See Support & lab.', '1. Orion: restore the host.', '2. Phoenix: add NR exports.']);
  assert.deepEqual(rich.rows, [
    ['Lab', 'Host', 'Status'], ['Orion', 'host-a', 'Unreachable'], ['Phoenix', 'host-b', 'NR exports missing'],
  ]);
  console.log('PASS rich paste retains clickable titles, numbered options, and a real table');

  // Copying only the table must offer HTML even though no cell contains a link.
  await page.evaluate(() => window.viewer.open({ filePath: '/copy-test.md' }));
  await page.locator('.md-viewer-body table').first().click();
  // Wait out the preceding copy's success flash before waiting for this copy.
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '⧉ table');
  await page.locator('.md-copy-body').click();
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓');
  const tableOnly = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.equal(tableOnly.text, tableExpected);
  assert.ok(tableOnly.html.includes('<table'));
  console.log('PASS a table without links copies as HTML with labeled plain-text rows');

  // A source copy replaces the rich clipboard, rather than leaving stale HTML.
  await page.evaluate(() => window.viewer.open({ filePath: '/copy-test.md' }));
  await heading.first().click();
  await page.locator('.md-copy-body').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.waitForFunction(() => document.querySelector('.md-copy-body').textContent === '✓ md');
  const raw = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
  assert.equal(raw.text, source.split('## Draft\n\n')[1].split('\n\n## Notes')[0]);
  assert.equal(raw.html, '');
  console.log('PASS markdown source copy replaces both clipboard flavors');

  const clickImage = async (alt) => {
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
    const { x, y } = await point.jsonValue();
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
  assert.deepEqual(errors, []);
  console.log('PASS modifier-copy writes the containing block source');
} finally {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
