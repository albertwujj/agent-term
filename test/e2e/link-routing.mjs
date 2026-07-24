// End-to-end regression: where a clicked link ends up.
//
// A link that asks for a new window (target=_blank, window.open) used to get a
// bare BrowserWindow — the app's icon, no address bar, no back button. Every such
// link now goes to the system browser, as does an http link inside a rendered
// review or an md doc, while a plain link on a browsed page keeps navigating in
// place. shell.openExternal is stubbed in-process, so a run opens no browser.

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(APP_DIR, 'test', 'fixtures');
const ELECTRON_BIN = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
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
    await page.keyboard.press('Escape'); // the startup session picker
    await sleep(300);

    // Record what would have been handed to the browser instead of opening one.
    await app.evaluate(({ shell }) => {
      globalThis.__ext = [];
      shell.openExternal = (u) => { globalThis.__ext.push(u); return Promise.resolve(); };
    });
    const drainExternal = () => app.evaluate(() => {
      const seen = globalThis.__ext;
      globalThis.__ext = [];
      return seen;
    });
    const state = () => app.evaluate(({ BrowserWindow, webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      return {
        windows: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
        guest: guest ? guest.getURL() : null,
      };
    });
    // A review page follows a link only on a modified click — the plain one belongs
    // to its commenting gestures — so the guest click carries metaKey when asked.
    const clickInGuest = (id, { follow = false } = {}) => app.evaluate(({ webContents }, [elId, withModifier]) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
      return guest.executeJavaScript(
        `document.getElementById(${JSON.stringify(elId)}).dispatchEvent(`
        + `new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: ${!!withModifier} }))`,
      );
    }, [id, follow]);
    const runCommand = async (command) => {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await sleep(400);
    };
    const openViewer = async (target, selector) => {
      await runCommand(`echo ${target}`);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('open-recent-viewer-url');
      });
      await page.waitForSelector(selector, { timeout: 10_000 });
      await sleep(1200);
    };
    const isShell = (u) => /src[/\\]index\.html$/.test(u || '');

    // --- web viewer: popups leave, plain links keep browsing in place ---
    await openViewer(url.pathToFileURL(path.join(FIXTURES, 'e2e-link-popup.html')).href, '.vb-shell.vb-web.open');

    await clickInGuest('blank');
    await sleep(900);
    let s = await state();
    check('target=_blank spawns no app window', s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('target=_blank goes to the system browser',
      (await drainExternal()).includes('https://example.com/blank-target'));

    await clickInGuest('popup');
    await sleep(900);
    s = await state();
    check('window.open spawns no app window', s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('window.open goes to the system browser',
      (await drainExternal()).includes('https://example.com/js-popup'));

    await clickInGuest('inline');
    await sleep(1200);
    s = await state();
    check('plain link still browses in place', /e2e-link-popup\.html\?browsed=1/.test(s.guest || ''), s.guest);
    check('plain link stayed in the viewer', (await drainExternal()).length === 0);

    // --- review page: http links leave, the review itself stays put ---
    await page.locator('.vb-shell.vb-web .vb-close').click();
    await sleep(600);
    await openViewer(url.pathToFileURL(path.join(FIXTURES, 'e2e-review-links.html')).href, '.vb-shell.vb-web.open');

    await clickInGuest('ext');
    await sleep(900);
    s = await state();
    check('a plain click on a review link follows nothing', (await drainExternal()).length === 0);
    check('and the review page stays put', /e2e-review-links\.html$/.test(s.guest || ''), s.guest);

    await clickInGuest('ext', { follow: true });
    await sleep(900);
    s = await state();
    check('a modified click on a review link goes to the system browser',
      (await drainExternal()).includes('https://example.com/review-ext'));
    check('review page was not navigated away', /e2e-review-links\.html$/.test(s.guest || ''), s.guest);

    await clickInGuest('frag');
    await sleep(600);
    s = await state();
    check('review in-page fragment nav still works', /e2e-review-links\.html#top$/.test(s.guest || ''), s.guest);
    check('fragment nav stayed in the viewer', (await drainExternal()).length === 0);

    // --- md viewer: http leaves, a relative link never eats the app shell ---
    await page.locator('.vb-shell.vb-web .vb-close').click();
    await sleep(600);
    await openViewer(path.join(FIXTURES, 'e2e-md-links.md'), '.vb-shell.vb-md.open');
    await page.waitForSelector('.md-viewer-body a', { timeout: 10_000 });

    const clickDocLink = (selector, follow) => page.evaluate(([sel, withModifier]) => {
      document.querySelector(sel).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: withModifier }),
      );
    }, [selector, follow]);

    await clickDocLink('a[href^="https://example.com/md-ext"]', false);
    await sleep(700);
    check('a plain click on an md link follows nothing', (await drainExternal()).length === 0);
    check('it arms the block for a comment instead',
      await page.evaluate(() => !!document.querySelector('.md-comment-target-active')));
    check('and the hint names the modifier',
      await page.evaluate(() => /click follows/.test(document.querySelector('.md-comment-hint')?.textContent || '')));
    await page.keyboard.press('Escape');
    await sleep(300);

    await clickDocLink('a[href^="https://example.com/md-ext"]', true);
    await sleep(700);
    check('md viewer http link goes to the system browser on a modified click',
      (await drainExternal()).includes('https://example.com/md-ext'));

    await clickDocLink('a[href="./e2e-md-link-target.md"]', true);
    await page.waitForFunction(
      () => /md link target/i.test(document.querySelector('.md-viewer-body h1')?.textContent || ''),
      { timeout: 10_000 },
    ).catch(() => {});
    s = await state();
    const shown = await page.evaluate(() => ({
      heading: document.querySelector('.md-viewer-body h1')?.textContent || '',
      title: document.querySelector('.vb-shell.vb-md .vb-title')?.textContent || '',
    }));
    check('md viewer relative link opens that doc in the viewer',
      /md link target/i.test(shown.heading) && /e2e-md-link-target\.md/.test(shown.title), shown);
    check('following a doc link never navigates the app shell',
      s.windows.length === 1 && isShell(s.windows[0]), s.windows);
    check('following a doc link stays out of the browser', (await drainExternal()).length === 0);

    // --- the app shell itself never navigates ---
    await page.evaluate(() => { window.location.href = 'https://example.com/host-nav'; });
    await sleep(1200);
    s = await state();
    check('app shell navigation blocked', isShell(s.windows[0]), s.windows);
    check('app shell navigation goes to the system browser',
      (await drainExternal()).includes('https://example.com/host-nav'));
  } finally {
    await app.close();
  }
  if (failures) throw new Error(`${failures} link-routing check(s) failed`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
