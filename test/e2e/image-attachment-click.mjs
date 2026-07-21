// End-to-end regression for Claude Code image-attachment click-to-open.
//
// Claude Code prints `› [image]<path> (<size>)` and, when the path outruns the
// row, hangs the remainder onto the next row (indented to the path column) with
// the size pinned to the first row — splitting the path mid-token across hard
// newlines. The renderer stitches the pieces back into one clickable target.
//
// This drives the REAL app: it prints that exact two-row layout for a real PNG,
// asserts both fragments are underlined and hover-clickable, and asserts a click
// on EITHER fragment opens the reassembled full path (captured at the main-side
// 'open-resource' IPC boundary, so no file is actually opened).
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

// A real (blank 1×1) PNG at a long path, plus a shell script that prints the
// two-row split layout Claude Code actually emits: "  › [image] <path> (size)".
// The path starts at column 12 (after the SPACE past "[image]"), but Ink hangs
// the wrapped remainder one column LEFT of that — under the marker region, at
// column 11 — so the continuation does NOT line up with the path's first char.
// Reproducing that offset is the whole point: anchoring reassembly at the path
// column (not the marker) silently dropped these and sent clicks to the IDE.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-attach-'));
const pngPath = path.join(tmp, 'e2e-image-attachment-verify-shot.png');
fs.writeFileSync(pngPath, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
const head = pngPath.slice(0, pngPath.length - 6);
const frag = pngPath.slice(pngPath.length - 6);
const line1 = `  › [image] ${head} (12KB)`;
const line2 = `${' '.repeat(11)}${frag}`;   // hang one column left of the path start
const scriptPath = path.join(tmp, 'show.sh');
// Single-quote the format so the shell doesn't strip the backslash; printf then
// repeats '%s\n' for each arg, emitting the two rows on real newlines.
fs.writeFileSync(scriptPath, `printf '%s\\n' ${JSON.stringify(line1)} ${JSON.stringify(line2)}\n`);

async function main() {
  if (line1.length > 200) throw new Error('head row too long for the test window width');
  const app = await electron.launch({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1750, 980));
  await sleep(1200);

  const focusTerm = () => page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  const runCmd = async (cmd) => { await focusTerm(); await page.keyboard.type(cmd); await page.keyboard.press('Enter'); };

  // Capture opens at the main-process IPC boundary — window.pty is a
  // contextBridge object and can't be stubbed in the renderer.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__opened = null;
    ipcMain.removeHandler('open-resource');
    ipcMain.handle('open-resource', (_e, p) => { globalThis.__opened = p; return { success: true }; });
  });
  const captured = () => app.evaluate(() => globalThis.__opened);
  const resetCapture = () => app.evaluate(() => { globalThis.__opened = null; });

  try {
    await page.keyboard.press('Escape');   // skip the session picker
    await sleep(300);
    await runCmd('clear');
    await sleep(300);
    await runCmd(`sh ${scriptPath}`);
    await sleep(1500);                      // let the decoration loop run

    // The path fragments sit at columns 11–12 (x ≈ 105–116); the echoed command
    // line's own show.sh path sits further right and is not part of this feature.
    const decos = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-decoration'))
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
      .filter((r) => r.w > 0 && r.h > 0 && r.x < 200).sort((a, b) => a.y - b.y));
    check('both path segments underlined', decos.length === 2, `(got ${decos.length})`);

    for (let i = 0; i < decos.length; i++) {
      await resetCapture();
      const d = decos[i];
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      await page.mouse.move(cx, cy);
      await sleep(120);
      const cursor = await page.evaluate(() => { const el = document.querySelector('.xterm-screen'); return el && getComputedStyle(el).cursor; });
      check(`segment ${i} shows a pointer cursor`, cursor === 'pointer', `(cursor ${cursor})`);
      await page.mouse.click(cx, cy);
      await sleep(400);
      const opened = await captured();
      check(`click on segment ${i} opens the reassembled full path`, opened === pngPath, `\n     got: ${opened}\n     exp: ${pngPath}`);
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
