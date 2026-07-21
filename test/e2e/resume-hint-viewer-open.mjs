// End-to-end regression: opening either viewer dismisses the resume hint.
// The picker payload is synthetic so the test does not depend on session history;
// renderer behavior is otherwise the shipped picker/viewer flow.

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const MD_FIXTURE = path.join(APP_DIR, 'test', 'fixtures', 'md-viewer-test.md');
const WEB_FIXTURE = path.join(APP_DIR, 'test', 'fixtures', 'e2e-viewer.html');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function showResumeHint(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('show-picker', {
      sessions: [{
        id: 987654321,
        cli: 'claude',
        prompt: 'Synthetic resume-hint viewer test',
        title: 'Viewer test',
        timestamp: Date.now(),
      }],
      activeIds: [],
    });
  });
  await page.waitForSelector('.at-picker-overlay');
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.at-picker-row'))
      .find((candidate) => !candidate.classList.contains('at-picker-row-new'));
    if (!row) throw new Error('Synthetic past-session row was not rendered');
    row.click();
  });
  await page.waitForSelector('.at-resume-hint');
}

async function openMostRecentViewer(app, page, selector) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
  });
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('.at-resume-hint'));
}

async function run() {
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

    const runCommand = async (command) => {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await sleep(350);
    };

    await runCommand(`echo ${MD_FIXTURE}`);
    await showResumeHint(app, page);
    await openMostRecentViewer(app, page, '.vb-shell.vb-md.open');
    console.log('  PASS markdown viewer open dismisses resume hint');

    await page.locator('.vb-shell.vb-md .vb-close').click();
    await runCommand(`echo ${url.pathToFileURL(WEB_FIXTURE).href}`);
    await showResumeHint(app, page);
    await openMostRecentViewer(app, page, '.vb-shell.vb-web.open');
    console.log('  PASS web/review viewer open dismisses resume hint');
  } finally {
    await app.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
