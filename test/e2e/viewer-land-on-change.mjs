// The agent's change brings a rolled-up md band up full on the page that
// holds it, a change to the doc or a reply on a thread, once the agent is
// through: a change while a sent thread still waits on the agent holds the
// band until the reply, which lands it on the highest place the two went to.
// A band the user already had up (split or full) comes up full on the page it
// was on. The doc is long, so each change lands off the page the user was
// reading. Drives the real app; main's file and store reads are stubbed so the
// test plays the agent by changing what they return.
//
// Run: npm run test:e2e
import { launchElectron } from './electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const DOC = path.join(APP_DIR, 'test/fixtures/md-viewer-test.md');
const paragraphs = Array.from({ length: 60 }, (_, i) =>
  `Paragraph ${i} of the document, long enough to fill lines of a page.`);
const source = (extra = {}) => ['# Doc', ...(extra.top ? [extra.top] : []), ...paragraphs, ...(extra.end ? [extra.end] : [])].join('\n\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-land-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? ` (${detail})` : '')); console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}

const app = await launchElectron({
  executablePath: ELECTRON_BIN,
  args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'userdata')}`, APP_DIR],
  timeout: 45_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.xterm-helper-textarea');
  await page.waitForTimeout(1200);
  if (await page.locator('.at-picker-overlay').count()) await page.keyboard.press('Escape');
  // The doc main serves, which the test rewrites to play the agent.
  const serve = (content, mtimeMs) => app.evaluate((_, [doc, content, mtimeMs]) => {
    globalThis.__landDoc = { doc, content, mtimeMs };
  }, [DOC, content, mtimeMs]);
  await serve(source(), 1);
  // One thread near the top, waiting on the agent.
  const ANCHOR = 'Paragraph 2 of the document, long enough to fill lines of a page.';
  const store = (agentSaid) => app.evaluate((_, [anchor, agentSaid]) => {
    const messages = [{ author: 'user', body: 'Is this right?', ts: 1, turn: 1 }];
    if (agentSaid) messages.push({ author: 'agent', body: agentSaid, ts: 2, turn: 1 });
    // The merged view main serves: the agent's answer carries its status.
    const status = agentSaid ? { status: 'resolved' } : {};
    globalThis.__landStore = { version: 1, turn: 1, threads: [{ id: 't1', anchor: { snippet: anchor }, ...status, messages }] };
  }, [ANCHOR, agentSaid]);
  await store(null);
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    const d = () => globalThis.__landDoc;
    for (const [channel, handler] of [
      ['read-markdown-file', () => ({ success: true, path: d().doc, content: d().content, mtimeMs: d().mtimeMs, size: d().content.length })],
      ['stat-markdown-file', () => ({ success: true, path: d().doc, mtimeMs: d().mtimeMs, size: d().content.length })],
      ['md-read-threads', () => ({ success: true, data: globalThis.__landStore })],
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  });
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.focus();
  await page.keyboard.type(`echo ${DOC}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
  await page.waitForSelector('.secondary .md-viewer-body p');
  await page.waitForTimeout(600);

  const band = () => page.evaluate(() => {
    const s = document.querySelector('.vb-shell.vb-md');
    if (s.classList.contains('open')) return s.classList.contains('vb-full') ? 'full' : 'golden';
    return s.classList.contains('hidden') ? 'hidden' : 'closed';
  });
  const waitBand = async (want, ms) => {
    const until = Date.now() + ms;
    let got = await band();
    while (got !== want && Date.now() < until) { await page.waitForTimeout(100); got = await band(); }
    return got;
  };
  // On one of the two pages, under nothing: what the user can see.
  const onScreen = (text) => page.evaluate((text) => {
    for (const p of document.querySelectorAll('.md-viewer-body p')) {
      if (!p.textContent.includes(text)) continue;
      const r = p.getBoundingClientRect();
      if (r.height <= 0) continue;
      const hit = document.elementFromPoint(r.left + 12, r.top + r.height / 2);
      if (hit && p.contains(hit)) return true;
    }
    return false;
  }, text);
  check('the doc opens full', await band() === 'full', await band());
  check('on its first page', await onScreen('Paragraph 0 '));

  const rollUpByTyping = async () => {
    await terminal.focus();
    await page.keyboard.type('x');
    await page.keyboard.press('Control+U'); // the typing is over
    return waitBand('hidden', 2000);
  };

  // Rolled up by typing in the terminal, the agent changes the doc's end
  // while the thread near the top still waits on it: the band holds until
  // the thread's status, then comes up on the page holding the thread, the
  // higher of the two.
  console.log('A change while a thread waits, out of a roll-up');
  check('typing rolls the band up', await rollUpByTyping() === 'hidden', await band());
  const END = 'The agent wrote this at the very end.';
  await serve(source({ end: END }), 2);
  await page.waitForTimeout(4000); // the doc poll, and more than the rest after it
  check('the change holds the band while the thread waits', await band() === 'hidden', await band());
  await store('Yes, it is.');
  check('the resolve brings it up full', await waitBand('full', 5000) === 'full', await band());
  await page.waitForTimeout(500);
  check('on the page that holds the thread', await onScreen('Paragraph 2 '));
  check('which left the change below', !(await onScreen(END)));

  // Nothing waits now: a change at the end brings the band up on its page.
  console.log('A change with nothing waiting, out of a roll-up');
  check('typing rolls the band up again', await rollUpByTyping() === 'hidden', await band());
  const LATER = 'The agent wrote this later, at the end.';
  await serve(source({ end: `${END}\n\n${LATER}` }), 3);
  check('the change brings it up full', await waitBand('full', 5000) === 'full', await band());
  await page.waitForTimeout(500);
  check('on the page that holds the change', await onScreen(LATER));
  check('which left the first page', !(await onScreen('Paragraph 0 ')));

  // At the split the user is reading: the change takes the band full, on the
  // page it was on.
  console.log('From the split');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('viewer-shortcut', 'size'));
  check('the size chord splits', await waitBand('golden', 2000) === 'golden', await band());
  const TOP = 'The agent wrote this at the top.';
  await serve(source({ top: TOP, end: `${END}\n\n${LATER}` }), 4);
  check('the change takes it full', await waitBand('full', 5000) === 'full', await band());
  await page.waitForTimeout(500);
  check('on the page the user was reading', await onScreen(LATER));
  check('which does not turn to the change', !(await onScreen(TOP)));
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
