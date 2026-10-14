// End-to-end: the agent's edit while a comment is open or queued.
//
// A refresh used to wait behind any unsent comment, queued ones included, with
// no sign after the band's arrival flash: the page looked current for minutes,
// then the edit landed with a pulse at Send, as if the Send had caused it. An
// open composer still holds the edit, but the bar keeps the unseen hue a
// roll-up shows, and Send lands it at once; a queued comment holds nothing
// unless the agent touched its own block.
import assert from 'node:assert/strict';
import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const SOURCE = '# Held refresh\n\n' + Array.from({ length: 40 }, (_, i) =>
  `Paragraph ${i} has a selected word and enough following text to keep the document flowing.`).join('\n\n');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1500, height: 922 });
  await app.evaluate(({ ipcMain }, [doc, source]) => {
    globalThis.__disk = { content: source, mtimeMs: 1 };
    globalThis.__store = { version: 1, turn: 0, threads: [] };
    const file = () => ({ success: true, path: doc, ...globalThis.__disk, size: globalThis.__disk.content.length });
    for (const [channel, handler] of [
      ['read-markdown-file', () => file()],
      ['stat-markdown-file', () => { const { content, ...stat } = file(); return stat; }],
      ['md-read-threads', () => ({ success: true, data: globalThis.__store })],
      ['md-runbook-preflight', () => ({ runbook: '/stub/agent-threads/md/user-intent.md' })],
      ['md-add-threads', (_event, payload) => {
        const s = globalThis.__store;
        globalThis.__store = { ...s, turn: s.turn + 1, threads: s.threads.concat(payload.threads.map((t, i) => ({
          id: `t-${s.turn + 1}-${i}`, anchor: t.anchor, anchor_status: 'ok',
          messages: [{ author: 'user', body: t.body, ts: Date.now(), turn: s.turn + 1 }],
        }))) };
        return { success: true, data: globalThis.__store };
      }],
    ]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, [DOC, SOURCE]);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.vb-shell.vb-md.open .md-viewer-body h1');
  await page.waitForTimeout(1500);

  const agentRewrites = (i, text) => app.evaluate((_, [i, text]) => {
    const d = globalThis.__disk;
    globalThis.__disk = {
      content: d.content.replace(new RegExp(`^Paragraph ${i} .*$`, 'm'), text),
      mtimeMs: d.mtimeMs + 1,
    };
  }, [i, text]);
  const leftText = (prefix) => page.evaluate((prefix) => {
    const el = [...document.querySelectorAll('.primary .md-viewer-body [data-md-anchor-id]')]
      .find((b) => b.textContent.startsWith(prefix));
    return el ? { text: el.textContent, pulse: el.classList.contains('md-change-pulse') } : null;
  }, prefix);
  const unseenHue = () => page.locator('.vb-shell.vb-md').evaluate((el) => el.classList.contains('vb-unseen'));
  // A paragraph wholly on the right page, as in the report.
  const rightParagraph = (skip = '') => page.evaluate((skip) => {
    const vp = document.querySelector('.secondary .md-page-viewport').getBoundingClientRect();
    return [...document.querySelectorAll('.secondary .md-viewer-body p[data-md-anchor-id]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.top > vp.top + 40 && r.bottom < vp.bottom - 40 && el.textContent !== skip;
    })?.textContent;
  }, skip);

  // An open composer holds the edit; the bar keeps the unseen hue; Send lands it.
  assert.equal(await unseenHue(), false, 'nothing unseen before the agent writes');
  const first = await rightParagraph();
  await page.locator('.secondary p').filter({ hasText: first }).click();
  await page.keyboard.type('a comment on the right page');
  await agentRewrites(2, 'Paragraph 2 is what the agent wrote while the comment was open.');
  await page.waitForTimeout(3000);
  assert.match((await leftText('Paragraph 2 ')).text, /has a selected word/, 'the open composer holds the edit');
  assert.equal(await unseenHue(), true, 'the held edit keeps the unseen hue');
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForSelector('.md-comment-card', { state: 'detached' });
  await page.waitForTimeout(150); // well inside the 1s poll: Send itself lands it
  const landed = await leftText('Paragraph 2 ');
  assert.match(landed.text, /while the comment was open/, 'Send lands the held edit at once');
  assert.equal(landed.pulse, true, 'and pulses it');
  console.log('PASS an open composer holds the edit under the unseen hue, and Send lands it');

  // A queued comment holds nothing the agent wrote elsewhere.
  const second = await rightParagraph(first);
  await page.locator('.secondary p').filter({ hasText: second }).click();
  await page.keyboard.type('left queued');
  await page.locator('.primary h1').click(); // click away: the draft queues
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.md-queued-comment-mark').count(), 2);
  await agentRewrites(3, 'Paragraph 3 is what the agent wrote while the comment was queued.');
  await page.waitForTimeout(2500);
  assert.match((await leftText('Paragraph 3 ')).text, /while the comment was queued/, 'the edit lands with a comment queued');
  const seat = await page.evaluate(() => [...document.querySelectorAll('.md-queued-comment-mark')].map((mark) => {
    let el = mark.previousElementSibling;
    while (el && !el.hasAttribute('data-md-anchor-id')) el = el.previousElementSibling;
    return el?.textContent;
  }));
  assert.deepEqual(seat, [second, second], 'the mark stays under its block');
  console.log('PASS a queued comment lets the agent\'s edit elsewhere land, and keeps its mark');

  assert.deepEqual(errors, [], 'no renderer errors');
} finally {
  await app.close().catch(() => {});
}
