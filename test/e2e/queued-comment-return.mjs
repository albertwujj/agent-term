// Queued terminal comments leave marks without covering the output. The footer
// count brings their passages back and opens one editor at a time, cycling in
// passage order and saving changes when moving to the next comment.

import { launchElectron } from './electron.mjs';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`); }
}

async function main() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    // wordAt reads text and measures DOM ranges under .xterm-rows. WebGL
    // paints into a canvas instead, so use the app's DOM fallback here.
    args: ['--no-sandbox', '--disable-gpu', APP_DIR],
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1200);
  if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 620);
    globalThis.__queuedCommentSends = [];
    ipcMain.removeHandler('submit-inline-comment');
    ipcMain.handle('submit-inline-comment', (_event, body, opts) => {
      globalThis.__queuedCommentSends.push({ body, opts });
      return { success: true };
    });
  });

  const focusTerm = () => page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await sleep(700);
  };
  const wordAt = (needle, word) => page.evaluate(([t, target]) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(t) || rowText.includes('printf')) continue;
      const col = rowText.indexOf(target);
      if (col < 0) continue;
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent.length;
        if (seen + len > col) {
          const r = document.createRange();
          r.setStart(n, col - seen);
          r.setEnd(n, Math.min(len, col - seen + target.length));
          const b = r.getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
        }
        seen += len;
      }
    }
    return null;
  }, [needle, word]);
  const state = () => page.evaluate(() => {
    const c = document.querySelector('.terminal-comment-footer-count');
    const ruler = document.querySelector('canvas.xterm-decoration-overview-ruler');
    return {
      count: c ? c.textContent : null,
      countIsControl: !!c && c.tagName === 'BUTTON' && !c.disabled,
      cards: document.querySelectorAll('.terminal-comment-queued-card').length,
      editorText: document.querySelector('.terminal-comment-bubble textarea')?.value ?? null,
      marks: document.querySelectorAll('.terminal-comment-mark').length,
      hasRuler: !!ruler,
    };
  });
  const queueNote = async (anchor, note) => {
    const t = await wordAt(anchor, anchor);
    if (!t) throw new Error(`anchor ${anchor} not found`);
    await page.mouse.dblclick(t.x, t.y);
    await sleep(500);
    await focusTerm();
    await page.keyboard.type(note);
    await page.waitForSelector('.terminal-comment-bubble textarea');
    await page.mouse.click(40, 560);
    await page.waitForSelector('.terminal-comment-bubble', { state: 'detached' });
    await sleep(250);
  };
  const nextComment = async () => {
    await page.click('.terminal-comment-footer-count');
    await page.waitForSelector('.terminal-comment-bubble textarea');
    await sleep(250);
    return state();
  };

  try {
    await runCmd('clear');
    await runCmd(`printf '%s\\n' 'ANCHOR-ALPHA the first line worth commenting on' 'ANCHOR-BETA the second passage' 'ANCHOR-GAMMA the third passage'`);
    await sleep(900);

    console.log('drafts rest as marks without covering the output');
    // Authoring order differs from passage order, and three comments catch a
    // cycle that accidentally bounces between just the first two editors.
    for (const name of ['GAMMA', 'ALPHA', 'BETA']) {
      await queueNote(`ANCHOR-${name}`, `note on ${name}`);
    }

    let s = await state();
    check('the footer counts all three', s.count === '3 comments', s);
    check('and the count is a live control', s.countIsControl, s);
    check('no queued boxes or editor cover the output', s.cards === 0 && s.editorText === null, s);
    check('the passage highlights remain', s.marks >= 3, s);
    check('the overview ruler remains', s.hasRuler, s);

    console.log('scrolling the passages away keeps the queue reachable');
    await runCmd(`for i in $(seq 1 60); do echo "filler line $i"; done`);
    await sleep(1200);
    s = await state();
    check('the passages are off screen', await wordAt('ANCHOR-ALPHA', 'ANCHOR-ALPHA') === null);
    check('the output stays clear', s.cards === 0 && s.editorText === null, s);
    check('the count still reports the unsent work', s.count === '3 comments', s);

    console.log('the count opens every comment in passage order');
    s = await nextComment();
    check('the first click opens ALPHA', s.editorText === 'note on ALPHA', s);
    check('and scrolls its passage into view', !!await wordAt('ANCHOR-ALPHA', 'ANCHOR-ALPHA'));
    check('opening a comment keeps the total count', s.count === '3 comments', s);
    await page.locator('.terminal-comment-bubble textarea').fill('revised note on ALPHA');
    for (const name of ['BETA', 'GAMMA']) {
      s = await nextComment();
      check(`the next click opens ${name}`, s.editorText === `note on ${name}`, s);
    }
    s = await nextComment();
    check('cycling back keeps the edit', s.editorText === 'revised note on ALPHA', s);

    console.log('Escape restores a queued comment without leaving a box');
    await page.locator('.terminal-comment-bubble textarea').fill('temporary unsaved edit');
    await page.keyboard.press('Escape');
    s = await state();
    check('all three comments remain with no boxes', s.count === '3 comments' && s.cards === 0 && s.editorText === null, s);
    await page.mouse.move(300, 300);
    await page.mouse.wheel(0, 800);
    await sleep(350);
    s = await state();
    check('scrolling keeps queued comments collapsed', s.cards === 0 && s.editorText === null, s);

    console.log('To prompt collects both queued and open comments');
    s = await nextComment();
    check('navigation continues after Escape', s.editorText === 'note on BETA', s);
    await page.locator('.terminal-comment-bubble textarea').fill('revised note on BETA');
    await page.locator('.terminal-comment-footer').getByRole('button', { name: 'To prompt', exact: true }).click();
    await page.waitForSelector('.terminal-comment-footer', { state: 'detached' });
    const sends = await app.evaluate(() => globalThis.__queuedCommentSends);
    check('one batch goes to the prompt', sends.length === 1 && sends[0].opts.toPrompt === true, sends);
    const body = sends[0]?.body || '';
    for (const note of ['revised note on ALPHA', 'revised note on BETA', 'note on GAMMA']) {
      check(`the batch contains ${note} exactly once`, body.split(note).length === 2, body);
    }
    check('Escape reverted the temporary edit', !body.includes('temporary unsaved edit'), body);
    s = await state();
    check('delivery clears the count, editor and marks', s.count === null && s.editorText === null && s.marks === 0, s);

    console.log('a single queued comment can be reopened and discarded');
    await queueNote('ANCHOR-ALPHA', 'one more note');
    s = await nextComment();
    check('a new batch starts with its own comment', s.count === '1 comment' && s.editorText === 'one more note', s);
    await page.locator('.terminal-comment-bubble').getByRole('button', { name: 'Discard', exact: true }).click();
    s = await state();
    check('discard removes the last comment and its marks', s.count === null && s.editorText === null && s.marks === 0, s);
  } finally {
    await app.close().catch(() => {});
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
