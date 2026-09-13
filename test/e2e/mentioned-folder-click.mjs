// End-to-end regression for opening a bare file name from a folder the
// terminal printed earlier (src/mentioned-folders.js).
//
// An agent working in a scratch directory prints its absolute path in a tool
// header, then a few lines later names a file there by bare name or by a short
// tail. That directory is outside the repo and outside home, so the click's
// tree searches can never reach it; the printed folder is the one lead.
//
// This drives the REAL app: a temp directory under the OS temp root (outside
// home on macOS) holds a PNG with a name that exists nowhere else; the shell
// prints a Write header with its absolute path, then two lines naming the file
// by bare name and by `scratchpad/<name>`; a click on each opens the image in
// the band, and the band's document is the file in the temp directory.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let passed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-'));
const scratch = path.join(tmp, 'scratchpad');
fs.mkdirSync(scratch);
const NAME = 'e2e-mention-shot.png';
const pngPath = path.join(scratch, NAME);
fs.writeFileSync(pngPath, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
const lines = [
  `⏺ Write(${pngPath})`,
  '  ⎿  Wrote 1 line',
  `The mock is at ${NAME} if you want a look.`,
  `Also rendered: scratchpad/${NAME} (same file).`,
];
const scriptPath = path.join(tmp, 'show.sh');
fs.writeFileSync(scriptPath, `printf '%s\\n' ${lines.map((l) => JSON.stringify(l)).join(' ')}\n`);

async function main() {
  if (lines[0].length > 200) throw new Error('header row too long for the test window width');
  const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1750, 980));
  await sleep(1200);

  const focusTerm = () => page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  const runCmd = async (cmd) => { await focusTerm(); await page.keyboard.type(cmd); await page.keyboard.press('Enter'); };
  const bandOpen = () => page.evaluate(() => !!document.querySelector('.vb-shell.vb-web.open'));
  const bandSrc = () => page.evaluate(() => {
    const view = document.querySelector('.vb-shell.vb-web webview');
    return view ? (view.getAttribute('src') || view.src || '') : '';
  });
  const closeBand = async () => {
    const close = page.locator('.vb-shell.vb-web .vb-close');
    if (await close.count()) { await close.click(); await sleep(500); }
  };

  try {
    await page.keyboard.press('Escape');   // skip the session picker
    await sleep(300);
    await runCmd('clear');
    await sleep(300);
    await runCmd(`sh ${scriptPath}`);
    await sleep(1500);                      // let the decoration loop run

    // Decorations, top to bottom: the echoed command's show.sh, the header's
    // absolute path, the bare name, the tail. The two lowest are the targets.
    const decos = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-decoration'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
      .filter((r) => r.w > 0 && r.h > 0).sort((a, b) => a.y - b.y));
    check('the bare name and the tail are both decorated', decos.length >= 3, `(got ${decos.length})`);
    const targets = [
      { label: 'bare name', deco: decos[decos.length - 2] },
      { label: 'scratchpad/ tail', deco: decos[decos.length - 1] },
    ];
    const expectedUrl = url.pathToFileURL(pngPath).href;

    for (const { label, deco } of targets) {
      if (!deco) { check(`${label}: decoration present`, false); continue; }
      const cx = deco.x + Math.min(deco.w / 2, 40), cy = deco.y + deco.h / 2;
      await page.mouse.move(cx, cy);
      await sleep(150);
      const cursor = await page.evaluate(() => { const el = document.querySelector('.xterm-screen'); return el && getComputedStyle(el).cursor; });
      check(`${label}: pointer cursor on hover`, cursor === 'pointer', `(cursor ${cursor})`);

      const started = Date.now();
      await page.mouse.click(cx, cy);
      await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 15_000 }).catch(() => {});
      const elapsed = Date.now() - started;
      check(`${label}: a click opens the image in the band`, await bandOpen(), `(after ${elapsed} ms)`);
      const src = await bandSrc();
      check(`${label}: the band shows the file from the printed folder`, src === expectedUrl,
        `\n     got: ${src}\n     exp: ${expectedUrl}`);
      console.log(`    (${label}: ${elapsed} ms from click to open)`);
      await closeBand();
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
