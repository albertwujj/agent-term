// End-to-end regression for a doc path a CLI wrapped across rows, printed with
// a line reference.
//
// Codex word-wraps its own prose: a long `path.md:67` breaks at a hyphen and
// the rest, line reference included, hangs on the next row behind a gutter.
// The renderer joins the two fragments into one target. This drives the REAL
// app: it prints that two-row layout for a real md doc, asserts both fragments
// are underlined, and asserts a click on the head, on the tail's path, or on
// its `:67` opens the doc in the viewer landed on line 67.
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { launchElectron } from './electron.mjs';
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

// One paragraph per odd line, so the block at line 67 names its own line.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-line-'));
const docPath = path.join(tmp, 'essays', 'files-in-terminal.md');
fs.mkdirSync(path.dirname(docPath));
fs.writeFileSync(docPath, Array.from({ length: 140 }, (_, i) => (
  i === 0 ? '# Wrapped line fixture' : (i % 2 === 0 ? `Paragraph at line ${i + 1}.` : '')
)).join('\n') + '\n');
const split = docPath.indexOf('wrapped-') + 'wrapped-'.length;
const rows = [
  `• I moved the link into the closing paragraph (\x1b[32m${docPath.slice(0, split)}`,
  `  ${docPath.slice(split)}:67\x1b[39m), made it explicit, and removed the overlapping landing-`,
  '  page entry.',
];

async function main() {
  const app = await launchElectron({ executablePath: ELECTRON_BIN, args: ['--no-sandbox', APP_DIR], timeout: 45_000 });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1750, 980));
    await sleep(1200);
    await page.keyboard.press('Escape');   // skip the session picker
    await sleep(300);

    // Hard rows straight into the terminal, as the CLI writes them.
    await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents
      .send('pty-output', data), `\x1b[2J\x1b[H${rows.join('\r\n')}\r\n\r\n`);
    await sleep(1500);                      // let the decoration loop run

    const decos = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-decoration'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, border: el.style.borderBottom };
      })
      .filter((r) => r.w > 0 && r.h > 0).sort((a, b) => a.y - b.y));
    check('both fragments are decorated as one target', decos.length === 2, `(got ${decos.length})`);
    check('and underlined at rest', decos.every((d) => /dotted/.test(d.border)), JSON.stringify(decos));
    if (decos.length !== 2) return;

    const [head, tail] = decos;
    const targets = {
      'the head fragment': [head.x + head.w / 2, head.y + head.h / 2],
      "the tail's path": [tail.x + 4, tail.y + tail.h / 2],
      "the tail's :67": [tail.x + tail.w - 4, tail.y + tail.h / 2],
    };
    for (const [name, [x, y]] of Object.entries(targets)) {
      await page.evaluate(() => document.querySelector('.vb-shell.vb-md.open .vb-close')?.click());
      await sleep(400);
      await page.mouse.move(x, y);
      await sleep(150);
      await page.mouse.click(x, y);
      await page.waitForSelector('.vb-shell.vb-md.open .md-landing-target', { timeout: 10_000 }).catch(() => {});
      const landed = await page.evaluate(() => document.querySelector('.md-landing-target')?.textContent.trim() || null);
      check(`a click on ${name} lands on line 67`, landed === 'Paragraph at line 67.', `(landed on ${landed})`);
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
    if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
  })
  .catch((err) => { console.error(err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
