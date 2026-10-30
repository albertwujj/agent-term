// To prompt starts on a new line only under text already in the composer, and
// never writes a bare LF to a shell, where it would run the line. Asserts the
// bytes the program received, in order, through the real app and a real shell.
//
// Run: npm run build && node test/e2e/to-prompt-newline.mjs

import { launchElectron } from './electron.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(APP_DIR, 'test', 'fixtures', 'raw-composer-cli.py');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paste = (text) => `\x1b[200~${text}\x1b[201~`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-to-prompt-'));
  const logPath = path.join(dir, 'received.log');
  const app = await launchElectron({
    executablePath: ELECTRON_BIN,
    args: ['--no-sandbox', APP_DIR],
    timeout: 45_000,
    env: { ...process.env, AGENT_TERM_START_CWD: dir },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
    await sleep(1200);
    if (await page.evaluate(() => !!document.querySelector('.at-picker-overlay'))) {
      await page.keyboard.press('Escape');
      await sleep(200);
    }

    const write = (data) => page.evaluate((d) => window.pty.write(d), data);
    const toPrompt = async (message) => {
      const result = await page.evaluate((m) => window.pty.submitInlineComment(m, { toPrompt: true }), message);
      check(`To prompt reports success for ${message}`, result && result.success, result);
      await sleep(1000);
    };
    const received = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');

    // Launched under a CLI's name, which is what the app detects a CLI by.
    await write(`codex() { python3 ${FIXTURE} ${logPath}; }\r`);
    await sleep(300);
    await write('codex\r');
    await sleep(1500);

    console.log('an empty composer takes the message as it is');
    check('its placeholder does not read as text', await page.evaluate(() => window.promptHoldsInput()) === false);
    await toPrompt('FIRST');
    check('no newline before the paste', received() === `${paste('FIRST')}\n\n`, received());

    console.log('text in the composer gets a newline first');
    await write('\x15');
    await sleep(300);
    await write('hello typed');
    await sleep(400);
    check('typed text reads as text', await page.evaluate(() => window.promptHoldsInput()) === true);
    await toPrompt('SECOND');
    check('the newline lands between the text and the paste',
      received() === `hello typed\n${paste('SECOND')}\n\n`, received());

    console.log('a caret already on a line of its own needs no newline');
    await toPrompt('THIRD');
    check('no second newline before the next paste',
      received() === `hello typed\n${paste('SECOND')}\n\n${paste('THIRD')}\n\n`, received());

    console.log('the shell a CLI left behind runs nothing');
    await write('\x03');
    await sleep(500);
    await write(`cd ${dir} && touch typed-ran`);
    await sleep(300);
    await toPrompt('; touch pasted-ran');
    await sleep(1000);
    check('neither the typed line nor the message ran',
      !fs.existsSync(path.join(dir, 'typed-ran')) && !fs.existsSync(path.join(dir, 'pasted-ran')),
      fs.readdirSync(dir));
    await write('\x03');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
