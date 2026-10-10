// End-to-end: every row of a numbered diff an agent prints under an edit lands
// on its line in the file the header names.
//
// A doc's diff used to work only on some rows. Each row took the nearest
// path-looking text above it as its file, and the rows above a diff row are the
// file's own text: line 6 found `/strong` in line 5's `</strong>` and went to
// the IDE, the addition of line 8 and line 10 found `comment.md` in the
// deletion's rows and opened that doc instead. The rows a long line wraps onto
// have no number and were no target at all. The fixture is the shape Claude
// Code prints, the doc's rows wrapped at 60 columns.

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

// [the row, by text only it carries; the word clicked on it; the text of the
// block the doc lands on]
const PICTURE = 'Code: what you propose';
const REVIEW = 'When the agent finishes, it prepares your review';
const EXPAND = 'You can ask the agent to expand any part';
const DOC_ROWS = [
  ['5  <br><strong>Code', 'propose', PICTURE],
  ['6  </p>', '</p>', PICTURE],
  ['8 -When the agent', 'finishes', REVIEW],
  ['--offs flagged;', 'flagged', REVIEW],
  ['- on its reasoning.', 'reasoning', REVIEW],
  ['8 +When the agent', 'finishes', REVIEW],
  ['+trade-off it chose', 'chose', REVIEW],
  ['+omment inline](comment.md)', 'comment.md', REVIEW],
  ['10  You can ask', 'expand', EXPAND],
  ['t most need your judgment first.', 'judgment', EXPAND],
];

// The same rows over code go to the IDE, so each names the file and the line.
const CODE_ROWS = [
  ['41    const message', 'summaryHeading', 41],
  ['42 -  return', 'formatReviewSummary', 42],
  ['-se, order:', 'order', 42],
  ['42 +  return', 'includeResolved', 42],
  ['+e, order:', 'limit', 42],
];

async function main() {
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    // wordTarget measures text under `.xterm-rows`, which only the DOM renderer
    // fills; without the GPU, WebGL fails to load and the renderer falls back.
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

  // Record IDE and OS requests instead of leaving the app.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__diffActions = [];
    for (const channel of ['navigate-to-file', 'navigate-to-symbol', 'open-resource', 'open-url']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, target) => {
        globalThis.__diffActions.push({ channel, target });
        return { success: true, status: 'ok' };
      });
    }
  });
  const actions = () => app.evaluate(() => globalThis.__diffActions);
  const clearActions = () => app.evaluate(() => { globalThis.__diffActions = []; });

  const runCmd = async (cmd) => {
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await sleep(700);
  };
  // The bottom-most row carrying `needle`, measured at `word` with a DOM Range.
  const wordTarget = (needle, word) => page.evaluate(([text, target]) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(text) || rowText.includes('e2e-diff-rows.txt')) continue;
      const col = rowText.indexOf(target);
      if (col < 0) continue;
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent.length;
        if (seen + len > col) {
          const range = document.createRange();
          range.setStart(node, col - seen);
          range.setEnd(node, Math.min(len, col - seen + target.length));
          const r = range.getBoundingClientRect();
          if (!r.width) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        seen += len;
      }
      return null;
    }
    return null;
  }, [needle, word]);
  const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

  try {
    await runCmd('clear');
    await runCmd('cat test/fixtures/e2e-diff-rows.txt');
    await sleep(1500);

    console.log('every row of a doc diff opens the doc on its line');
    for (const [needle, word, block] of DOC_ROWS) {
      await clearActions();
      const target = await wordTarget(needle, word);
      if (!target) { check(`row "${needle}" is on screen`, false); continue; }
      await page.mouse.click(target.x, target.y);
      const landed = await page.waitForSelector('.vb-shell.vb-md.open .md-landing-target', { timeout: 5_000 })
        .then(() => page.evaluate(() => ({
          title: document.querySelector('.vb-shell.vb-md .vb-title')?.textContent || '',
          text: document.querySelector('.vb-shell.vb-md .md-landing-target')?.textContent || '',
        })))
        .catch(() => null);
      check(`"${needle}" opens the diff's doc`, !!landed && landed.title.endsWith('e2e-diff-review.md'), landed?.title);
      check(`and lands on its line`, !!landed && landed.text.includes(block), landed?.text?.slice(0, 80));
      check('without a trip to the IDE', (await actions()).length === 0, await actions());
      if (await page.locator('.vb-shell.vb-md.open').count()) {
        await page.locator('.vb-shell.vb-md .vb-close').click();
        await page.waitForSelector('.vb-shell.vb-md.open', { state: 'detached', timeout: 5_000 }).catch(() => {});
      }
      await sleep(400);
    }

    console.log('every row of a code diff hands its file and line to the IDE');
    for (const [needle, word, line] of CODE_ROWS) {
      await clearActions();
      const target = await wordTarget(needle, word);
      if (!target) { check(`row "${needle}" is on screen`, false); continue; }
      await page.keyboard.down(MOD_KEY);
      await page.mouse.click(target.x, target.y);
      await page.keyboard.up(MOD_KEY);
      let sent = [];
      for (let i = 0; i < 40 && !sent.length; i++) { await sleep(50); sent = await actions(); }
      const request = sent.find((action) => action.channel === 'navigate-to-file')?.target;
      check(`"${needle}" goes to e2e-diff-code.js:${line}`,
        request?.filePath === 'test/fixtures/e2e-diff-code.js' && request?.line === line, sent);
      await sleep(300);
    }
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
