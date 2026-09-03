// End-to-end regression: a repainted review:// link leaves the band alone; a
// re-printed one reveals it.
//
// An AI CLI redraws its screen — on a resize, when its output shrinks, when a
// keystroke re-renders the input line — and a redraw re-emits every row on it,
// including a review link printed earlier, byte-for-byte. The renderer used to
// take such a re-emission for the agent printing the link again and pop the
// rolled-up review back up, over and over while the link stayed on screen. The
// survey now reads the terminal buffer: a redraw rewrites the link's row in
// place (the same copy), a re-print adds a row (a new copy), and only a new
// copy moves the band.
//
// The scenario runs as one shell script so nothing typed carries the link: the
// script prints it (auto-open), waits while the test rolls the band up with a
// keystroke, rewrites that same row in place, waits, then prints it on a new row.

import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

// A two-commit repo with a real package: the review renders and the band opens
// on a genuine page, the same path a session takes.
function makeReviewRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'at-review-reprint-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'f.py'), 'a = 1\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.appendFileSync(path.join(repo, 'f.py'), 'a = 2\n');
  git('commit', '-qam', 'two');
  const range = `${git('rev-parse', 'HEAD~1')}..${git('rev-parse', 'HEAD')}`;
  const dir = path.join(repo, '.git', 'review', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'main.md');
  fs.writeFileSync(pkg, `---\nrange: ${range}\n---\n\n# Review\n\nA change to f.py.\n\n:::diff f.py\n`);
  return { repo, pkg };
}

async function run() {
  const { repo, pkg } = makeReviewRepo();
  const script = path.join(repo, 'scenario.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `LINK="review://${pkg}"`,
    'echo "Review: $LINK"',            // the print: auto-opens the review
    'sleep 12',                        // render, the test's keystroke rolling the band up, quiet
    "printf '\\033[1A\\r\\033[2K'",    // a redraw: back onto that row, erase it,
    'echo "Review: $LINK"',            //   and write the same bytes in place
    'sleep 5',
    'echo "Review: $LINK"',            // the re-print: a new row
    'sleep 5',
  ].join('\n') + '\n');

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await sleep(1200);
    await page.keyboard.press('Escape'); // the startup session picker
    await sleep(300);

    const bandState = () => page.evaluate(() => {
      const shell = document.querySelector('.vb-shell.vb-web');
      if (!shell) return 'none';
      return shell.classList.contains('open') ? 'open' : shell.classList.contains('hidden') ? 'hidden' : 'closed';
    });
    const heldAt = async (state, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const s = await bandState();
        if (s !== state) return s;
        await sleep(200);
      }
      return state;
    };

    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`sh ${script}`);
    await page.keyboard.press('Enter');
    const started = Date.now();

    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 });
    check('the printed review:// opens the review', true);

    await page.keyboard.type('q'); // typing rolls the band up
    await page.waitForSelector('.vb-shell.vb-web.hidden', { timeout: 3000 });
    check('a keystroke rolls the band up', true);

    // The redraw lands 12s into the script; the survey follows it by a second.
    const redrawDone = started + 12_000 + 3000;
    const afterRedraw = await heldAt('hidden', Math.max(0, redrawDone - Date.now()));
    check('a redraw of the link in place leaves the band rolled up', afterRedraw === 'hidden', afterRedraw);

    // The re-print lands 17s in.
    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: Math.max(1000, started + 17_000 + 6000 - Date.now()) })
      .then(() => check('the link printed again reveals the band', true))
      .catch(async () => check('the link printed again reveals the band', false, await bandState()));
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
