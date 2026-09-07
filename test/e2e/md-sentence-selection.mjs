// Real Chromium mouse defaults: word -> sentence -> exact drag, including the
// facing page. Inspect the submitted payload without writing a comment store or
// sending anything to a user's agent; all viewer/selection code remains real.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SENTENCE = 'Second bold sentence, with a link and one(). Two() inside.';
const SOURCE = '# Sentence selection\n\nFirst sentence. Second **bold** sentence, with [a link](https://example.com/a?x=1) and `one(). Two()` inside. Third sentence.\n\n'
  + '```js\nfirst(); second();\nthird();\n```\n\n'
  + Array.from({ length: 24 }, (_, i) => `Paragraph${i} starts here. Another sentence, with a clause, for cross-page selection. Last sentence in this paragraph.`).join('\n\n');
const sleep = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`PASS ${name}`);
}

const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('renderer:', error));
  await page.waitForSelector('.xterm-helper-textarea');
  await sleep(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow, ipcMain }, [doc, source]) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    globalThis.__sentenceSends = [];
    globalThis.__sentenceLinks = [];
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: doc, content: source, mtimeMs: 1, size: source.length })],
      ['stat-markdown-file', () => ({ success: true, path: doc, mtimeMs: 1, size: source.length })],
      ['md-read-threads', () => ({ success: true, data: { threads: [] } })],
      ['md-runbook-preflight', () => ({ runbook: '/stub/agent-threads/md/user-intent.md' })],
      ['md-add-threads', (_e, payload) => { globalThis.__sentenceSends.push(payload); return { success: true, data: { threads: [] } }; }],
      ['open-url', (_e, target) => { globalThis.__sentenceLinks.push(target); return { success: true }; }],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await sleep(700);

  async function open() {
    if (await page.locator('.vb-shell.vb-md .vb-close').count()) {
      await page.locator('.vb-shell.vb-md .vb-close').click();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
    await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1', { timeout: 10000 });
    await sleep(350);
  }
  const selected = () => page.evaluate(() =>
    Array.from(CSS.highlights.get('md-comment-selection') || [])[0]?.toString()
    || window.getSelection().toString());
  const point = (needle, pane = 'primary', selector = 'p, pre') => page.evaluate(([needle, pane, selector]) => {
    const root = document.querySelector(`.md-spread-pane.${pane} .md-viewer-body`);
    const viewport = root.closest('.md-page-viewport').getBoundingClientRect();
    for (const el of root.querySelectorAll(selector)) {
      let offset = el.textContent.indexOf(needle);
      if (offset < 0) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset >= node.length) { offset -= node.length; continue; }
        const r = document.createRange(); r.setStart(node, offset); r.setEnd(node, offset + 1);
        const b = r.getBoundingClientRect();
        if (b.top >= viewport.top && b.bottom <= viewport.bottom && b.width > 0) {
          return { x: b.left + 0.5, y: b.top + b.height / 2 };
        }
        break;
      }
    }
    throw new Error(`No visible point for ${needle} in ${pane}`);
  }, [needle, pane, selector]);
  async function triple(p) {
    for (let clickCount = 1; clickCount <= 3; clickCount++) {
      await page.mouse.move(p.x, p.y);
      await page.mouse.down({ clickCount });
      await page.mouse.up({ clickCount });
      await sleep(25);
    }
    await sleep();
  }
  async function comment() {
    await page.keyboard.type('Please explain this.');
    await page.waitForSelector('.md-comment-card textarea');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForSelector('.md-comment-card', { state: 'detached' });
    return app.evaluate(() => globalThis.__sentenceSends.at(-1));
  }

  await open();
  let p = await point('bold');
  await page.mouse.dblclick(p.x, p.y);
  await sleep();
  check('double-click still selects a word', await selected(), 'bold');
  check('word comment quotes the word', (await comment()).threads[0].anchor.snippet, 'bold');

  await open();
  await triple(await point('bold'));
  check('three real presses select only the sentence', await selected(), SENTENCE);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  check('copy takes the sentence', await app.evaluate(({ clipboard }) => clipboard.readText()), SENTENCE);
  const sentencePayload = await comment();
  check('comment sends the highlighted sentence', sentencePayload.threads[0].anchor.snippet, SENTENCE);
  check('sentence remains a selection anchor', sentencePayload.threads[0].anchor.wholeBlock, false);
  check('To prompt stays unsent', sentencePayload.toPrompt, true);

  await open();
  await triple(await point('a link'));
  check('triple-clicking link text selects its sentence', await selected(), SENTENCE);
  check('link text did not navigate', await app.evaluate(() => globalThis.__sentenceLinks.length), 0);

  await open();
  await triple(await point('Second'));
  await page.keyboard.press('Backspace');
  await page.waitForSelector('.md-rendered-editing');
  check('Backspace edits exactly the selected sentence', await page.evaluate(() =>
    [...document.querySelectorAll('.md-rendered-editing del.md-pending-del')].map((el) => el.textContent).join('')), SENTENCE);
  await page.keyboard.press('Escape');

  await open();
  await triple(await point('first()', 'primary', 'pre'));
  check('code retains native whole-line selection', (await selected()).trim(), 'first(); second();');

  for (const reverse of [false, true]) {
    await open();
    const from = await point(reverse ? 'bold' : 'Second');
    const to = await point(reverse ? 'Second' : 'bold');
    await triple(from);
    // Another third press followed by movement must still be an exact drag.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ clickCount: 3 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up({ clickCount: 3 });
    await sleep();
    check(`${reverse ? 'backward' : 'forward'} drag overrides sentence selection`, (await comment()).threads[0].anchor.snippet, 'Second');
  }

  await open();
  // Find paragraphs whose first character is fully visible on the two pages.
  const visible = await page.evaluate(() => ['primary', 'secondary'].map((pane) => {
    const root = document.querySelector(`.md-spread-pane.${pane} .md-viewer-body`);
    const vp = root.closest('.md-page-viewport').getBoundingClientRect();
    return [...root.querySelectorAll('p')].filter((el) => {
      const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1);
      const b = r.getBoundingClientRect();
      return /^Paragraph\d+/.test(el.textContent) && b.top >= vp.top && b.bottom <= vp.bottom;
    }).map((el) => el.textContent.match(/^Paragraph\d+/)[0]);
  }));
  assert.ok(visible[0].length && visible[1].length, 'prose visible on both pages');
  const leftName = visible[0].at(-1);
  const rightName = visible[1][0];
  const from = await point(leftName);
  const to = await point(rightName, 'secondary');
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 }); await page.mouse.up();
  await sleep();
  const dragged = (await comment()).threads[0].anchor.snippet;
  check('drag across the fold retains the starting passage', dragged.startsWith(leftName), true);
  check('cross-page drag stops at the chosen endpoint', dragged.includes(rightName), false);

  await open();
  await triple(await point(rightName, 'secondary'));
  check('right page also selects a sentence', await selected(), `${rightName} starts here.`);
  check('right-page comment quotes the sentence', (await comment()).threads[0].anchor.snippet, `${rightName} starts here.`);
  console.log(`\n${passed} passed, 0 failed`);
} finally {
  await app.close().catch(() => {});
}
