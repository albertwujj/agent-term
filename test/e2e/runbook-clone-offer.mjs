// End-to-end: a Send from a comment card that finds no agent-threads runbook
// puts the choice in the card, with the composer's own buttons and no native
// alert: have the agent clone it (the README's prompt goes to the composer,
// the band drops from full size, the card waits and sends on its own when
// the clone lands), send without the guide, or cancel and keep the draft.
//
// Drives the real UI: the document open in the band, a word double-clicked,
// a comment typed, Send clicked, the strip's buttons clicked. The runbook
// ladder is starved (HOME, the start cwd and the document all in a scratch
// tree with no agent-threads above them). The pty's shell is a tiny script
// that appends every submitted line to a file, so what the terminal typed
// on the user's behalf is read back exactly. The native dialog is replaced
// by a recorder only to prove it is never shown on this surface.

import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGENT_THREADS_CLONE_PROMPT } = require('../../src/loop-install.js');

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const SHOT_DIR = process.env.AGENT_TERM_E2E_SHOTS || path.join(os.tmpdir(), 'agent-term-e2e');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(150);
  }
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-clone-'));
  const home = path.join(scratch, 'home');
  const proj = path.join(scratch, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const doc = path.join(proj, 'plan.md');
  fs.writeFileSync(doc, '# Plan\n\nThe opening paragraph of the plan.\n\nThe second paragraph.\n', 'utf8');
  const store = path.join(proj, '.agent-threads', 'plan-comments.json');
  const threads = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')).threads : []);
  const runbook = path.join(proj, 'ai', 'agent-threads', 'md', 'user-intent.md');
  const landClone = () => { fs.mkdirSync(path.dirname(runbook), { recursive: true }); fs.writeFileSync(runbook, '# runbook\n'); };
  const removeClone = () => fs.rmSync(path.join(proj, 'ai'), { recursive: true, force: true });

  const typed = path.join(scratch, 'typed.txt');
  const shell = path.join(scratch, 'shell.sh');
  fs.writeFileSync(shell, '#!/bin/sh\nwhile IFS= read -r line; do printf \'%s\\n\' "$line" >> "$AT_E2E_TYPED"; done\n');
  fs.chmodSync(shell, 0o755);
  const typedLines = () => (fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8').split('\n').filter(Boolean) : []);
  const unbracket = (s) => s.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  const promptLines = () => typedLines().filter((l) => unbracket(l) === AGENT_THREADS_CLONE_PROMPT);
  const pointerLines = () => typedLines().filter((l) => /My comments on markdown document/.test(l));

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', `--user-data-dir=${path.join(scratch, 'ud')}`, APP_DIR],
    env: { ...process.env, HOME: home, SHELL: shell, AT_E2E_TYPED: typed, AGENT_TERM_START_CWD: proj },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await sleep(1500);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = 0;
    dialog.showMessageBox = () => { globalThis.__dialogs++; return Promise.resolve({ response: 1, checkboxChecked: false }); };
  });
  const nativeDialogs = () => app.evaluate(() => globalThis.__dialogs);

  const bandFull = () => page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open.vb-full'));
  const notice = () => page.evaluate(() => {
    const n = document.querySelector('.md-comment-card .md-runbook-notice');
    if (!n) return null;
    return {
      text: n.querySelector('.md-runbook-text').textContent,
      link: n.querySelector('a') ? n.querySelector('a').getAttribute('href') : null,
      buttons: Array.from(n.querySelectorAll('.cu-btn')).map((b) => b.textContent),
      primaryTitle: n.querySelector('.cu-primary') ? n.querySelector('.cu-primary').title : null,
      composerActionsHidden: !!n.previousElementSibling && getComputedStyle(n.previousElementSibling.querySelector('.cu-actions')).display === 'none',
    };
  });
  const clickNotice = (label) => page.evaluate((label) => {
    const b = Array.from(document.querySelectorAll('.md-runbook-notice .cu-btn')).find((x) => x.textContent === label);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  const point = (needle) => page.evaluate((needle) => {
    const root = document.querySelector('.md-spread-pane.primary .md-viewer-body') || document.querySelector('.vb-shell.vb-md .md-viewer-body');
    for (const el of root.querySelectorAll('p')) {
      let offset = el.textContent.indexOf(needle);
      if (offset < 0) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset >= node.length) { offset -= node.length; continue; }
        const r = document.createRange(); r.setStart(node, offset); r.setEnd(node, offset + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
    }
    return null;
  }, needle);
  // Select a word, type: the first letter opens the card with the text.
  async function composeComment(word, text) {
    const p = await point(word);
    if (!p) return false;
    await page.mouse.dblclick(p.x, p.y);
    await sleep(200);
    await page.keyboard.type(text);
    const card = await waitFor(() => page.evaluate(() => {
      const ta = document.querySelector('.md-comment-card textarea');
      return ta ? ta.value : null;
    }));
    return card === text;
  }
  const clickSend = () => page.click('.md-comment-card .cu-btn.cu-primary');

  try {
    console.log('the document open in the band, at full size');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`echo ${doc}`);
    await page.keyboard.press('Enter');
    await sleep(700);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url'));
    const opened = await waitFor(() => page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open .md-viewer-body h1')));
    check('the band shows the document', !!opened);
    if (opened && !(await bandFull())) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('viewer-shortcut', 'size'));
      await sleep(400);
    }
    check('at full size', await bandFull());

    console.log('a comment sent with no runbook: the choice appears in the card');
    check('a comment card opens on the selected word with the typed text', await composeComment('opening', 'Tighten this.'));
    await clickSend();
    const shown = await waitFor(notice);
    check('the strip appears below the composer, in place of its actions', !!shown && shown.composerActionsHidden, shown);
    check('it says what is missing and links the README', !!shown && shown.text.startsWith('agent-threads is not installed.')
      && /README\.md#how-to-start$/.test(shown.link || ''), shown);
    check('with the clone first, then send anyway, then cancel', !!shown
      && JSON.stringify(shown.buttons) === JSON.stringify(['Ask the agent to clone it into ai/', 'Send anyway', 'Cancel']), shown && shown.buttons);
    check("and the clone button's tooltip is the README's prompt", !!shown && shown.primaryTitle === AGENT_THREADS_CLONE_PROMPT, shown && shown.primaryTitle);
    check('no store was written yet', !fs.existsSync(store));
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'runbook-choice.png') });

    console.log('the clone, taken, and landing');
    check('the clone button is there to click', await clickNotice('Ask the agent to clone it into ai/'));
    const line = await waitFor(() => promptLines()[0] || null);
    check("the terminal submitted the README's prompt, word for word, as one bracketed paste",
      !!line && line.startsWith('\x1b[200~') && line.endsWith('\x1b[201~'), line);
    const waiting = await waitFor(async () => { const n = await notice(); return n && /^Waiting for the agent to clone it\./.test(n.text) ? n : null; });
    check('the strip now waits, with send anyway and cancel', !!waiting && JSON.stringify(waiting.buttons) === JSON.stringify(['Send anyway', 'Cancel']), waiting);
    check('the band dropped from full size', !!(await waitFor(async () => !(await bandFull()))));
    check('and stays open on the document', await page.evaluate(() => !!document.querySelector('.vb-shell.vb-md.open')));
    await sleep(500);
    await page.screenshot({ path: path.join(SHOT_DIR, 'runbook-waiting.png') });
    check('the send is still held', !fs.existsSync(store) && (await notice()) !== null);
    landClone();
    const sent = await waitFor(() => (threads().length === 1 ? threads() : null));
    check('when the clone lands the send goes ahead on its own: the store holds the comment', !!sent && sent[0].messages[0].body === 'Tighten this.', sent);
    const pointer = await waitFor(() => (typedLines().some((l) => /user-intent\.md/.test(l)) ? true : null));
    check('and the pointer to the agent names the runbook it found', !!pointer, typedLines().slice(-4));
    check('the strip and the card are gone', (await notice()) === null && !(await page.evaluate(() => !!document.querySelector('.md-comment-card'))));

    console.log('send anyway, with no clone');
    removeClone();
    check('a second comment', await composeComment('second', 'And this.'));
    await clickSend();
    check('the strip is back', !!(await waitFor(notice)));
    check('send anyway is there to click', await clickNotice('Send anyway'));
    const two = await waitFor(() => (threads().length === 2 ? threads() : null));
    check('the store holds both comments', !!two && two[1].messages[0].body === 'And this.', two && two.length);
    check('with no second clone prompt typed', promptLines().length === 1, promptLines().length);

    console.log('cancel keeps the draft');
    check('a third comment', await composeComment('plan', 'Third.'));
    await clickSend();
    check('the strip is back', !!(await waitFor(notice)));
    check('cancel is there to click', await clickNotice('Cancel'));
    await sleep(300);
    const draft = await page.evaluate(() => { const ta = document.querySelector('.md-comment-card textarea'); return ta ? ta.value : null; });
    check('the strip is gone and the card stays open with the draft', (await notice()) === null && draft === 'Third.', draft);
    check('nothing more was sent', threads().length === 2);
    await page.keyboard.press('Escape');
    await sleep(300);

    console.log('with the clone in ai/');
    landClone();
    check('a fourth comment', await composeComment('opening', 'Fourth.'));
    await clickSend();
    const three = await waitFor(() => (threads().length === 3 ? threads() : null));
    check('the send goes straight through, no strip', !!three && (await notice()) === null, three && three.length);
    check('no native dialog was shown at any point', (await nativeDialogs()) === 0, await nativeDialogs());
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
