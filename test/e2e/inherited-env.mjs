// End-to-end check of what a window's shell inherits. Launches the REAL app
// with the environment of the 2026-09-07 launch that lost its colors: a
// launcher's tool shell had turned color off (NO_COLOR=1, COLORTERM emptied),
// replaced pagers, pinned a locale, marked its session, and npm had added its
// run-script variables and put node_modules/.bin first on PATH. Then reads
// `env` back out of the terminal and asserts the shell got the terminal's own
// identity and none of the launcher's settings (src/inheritable-env.js).
//
// Run: npm run test:e2e   (builds the renderer first, then this)

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const shell = process.env.SHELL || '/bin/zsh';
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // --disable-gpu: only the DOM renderer puts text under `.xterm-rows`,
    // which is how the output is read back (see click-vs-comment.mjs).
    args: ['--no-sandbox', '--disable-gpu', APP_DIR],
    env: {
      ...process.env,
      INIT_CWD: APP_DIR, // a source launch opens on npm's directory
      SHELL: shell,
      NO_COLOR: '1', COLOR: '0', COLORTERM: '', LC_ALL: 'C.UTF-8',
      PAGER: 'cat', GIT_PAGER: 'cat', GIT_EDITOR: 'true',
      CODEX_CI: '1', CLAUDECODE: '1', npm_lifecycle_event: 'start',
      PATH: `${path.join(APP_DIR, 'node_modules', '.bin')}:${process.env.PATH}`,
    },
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
  await sleep(1500); // let the shell print its first prompt

  // The echoed command line must not contain the marker, so it is assembled.
  const MARK = 'E2E-ENV-DONE';
  const command = [
    "env | grep -E '^(NO_COLOR|COLOR|COLORTERM|LC_ALL|PAGER|GIT_PAGER|GIT_EDITOR|CODEX_CI|CLAUDECODE|npm_lifecycle_event|TERM_PROGRAM|TERM)=' | sort",
    'case ":$PATH:" in *"/node_modules/.bin:"*) echo PATH-HAS-NPM-BIN;; *) echo PATH-CLEAN;; esac',
    'ps -o args= -p $$',
    "echo E2E-ENV-''DONE",
  ].join('; ');
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');

  const readRows = () => page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent || '').trimEnd()));
  let rows = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    rows = await readRows();
    if (rows.some((r) => r === MARK)) break;
    await sleep(250);
  }
  check('the command ran to its marker', rows.some((r) => r === MARK));
  const value = (name) => {
    const row = rows.find((r) => r.startsWith(`${name}=`));
    return row === undefined ? undefined : row.slice(name.length + 1);
  };

  check('TERM is the terminal\'s own', value('TERM') === 'xterm-256color');
  check('TERM_PROGRAM is the terminal\'s own', value('TERM_PROGRAM') === 'AgentTerm');
  check('COLORTERM declares truecolor over the launcher\'s empty value', value('COLORTERM') === 'truecolor');
  for (const name of ['NO_COLOR', 'COLOR', 'CODEX_CI', 'CLAUDECODE', 'npm_lifecycle_event']) {
    check(`${name} is gone`, value(name) === undefined);
  }
  // A profile may export these itself; the launcher's values must not survive.
  check('LC_ALL is not the launcher\'s', value('LC_ALL') !== 'C.UTF-8');
  check('PAGER is not the launcher\'s', value('PAGER') !== 'cat');
  check('GIT_PAGER is not the launcher\'s', value('GIT_PAGER') !== 'cat');
  check('GIT_EDITOR is not the launcher\'s', value('GIT_EDITOR') !== 'true');
  check('PATH has no node_modules/.bin from the launcher', rows.includes('PATH-CLEAN') && !rows.includes('PATH-HAS-NPM-BIN'));
  if (process.platform === 'darwin') {
    check('macOS runs a login shell', rows.some((r) => r === `${shell} -l`));
  }

  if (failures.length) {
    console.log('\nrows:\n' + rows.filter(Boolean).join('\n'));
  }
  await app.close();
}

main().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
