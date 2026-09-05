// End-to-end: in the terminal, a click navigates and a selection comments —
// the two never ride on the same gesture.
//
// A double click used to open a line comment, so on navigable output (a path, a
// URL, a diff line — most of what an agent prints) the first click navigated and
// the second opened a composer: one gesture, two unrelated actions. Double and
// triple click now belong to xterm's word and line select, which arm the
// type-to-comment pill; commenting always goes through a selection.
//
// Splitting the gestures left one collision behind. The first press of a double
// click is detail 1, so it still armed and navigated on its own release, and the
// widest patterns on the surface — bare identifiers, file:line, source and diff
// lines — all resolve through the IDE. Those now wait for ctrl/cmd. What keeps
// the plain click is what opens without taking the terminal away: a URL or an
// .html path in the viewer band, an .md path in the md viewer, a bare path with
// the OS.

import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as url from 'node:url';

const APP_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(APP_DIR, 'test', 'fixtures');
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
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // wordTarget below finds its click point by walking text nodes under
    // `.xterm-rows`, and only the DOM renderer puts text there. With WebGL up
    // those rows are empty and every target comes back null. Denying the GPU
    // makes WebglAddon fail to load and the renderer falls back to the DOM on
    // its own — the documented path it already takes on context loss. Nothing
    // here asserts how a cell is painted, only where a click lands and what
    // the app does with it, so the substrate is free to be either one.
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

  const focusTerm = () => page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
  });
  const runCmd = async (cmd) => {
    await focusTerm();
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await sleep(700);
  };
  const state = () => page.evaluate(() => ({
    band: !!document.querySelector('.vb-shell.vb-web.open'),
    bubble: !!document.querySelector('.terminal-comment-bubble'),
    pill: !!document.querySelector('.terminal-comment-selection-hint'),
  }));
  // What the gesture actually selected, read from the far end of the loop: type a
  // comment, send it, and the message the agent receives marks the selected span
  // as [selected]…[/selected]. The shell then errors on the pasted text, which is
  // why each case starts from a cleared screen.
  const commentAndSend = async (text) => {
    await focusTerm();
    await page.keyboard.type(text);
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await sleep(900);
    return page.evaluate(() => (
      [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent || '').join('\n')
    ));
  };
  // The most recent marker on screen: earlier cases leave their own in the
  // scrollback.
  const selectedIn = (screenText) => {
    const all = [...screenText.matchAll(/\[selected](.*?)\[\/selected]/gs)];
    return all.length ? all[all.length - 1][1] : null;
  };
  // An IDE navigation is invisible on a machine with no IDE listening, except
  // that it always reports: the TCP attempt resolves without a status and the
  // renderer flashes a nav-feedback toast. Presence of the toast is the proof
  // that the call fired at all, which is what the gesture rule is about.
  const navFired = async () => {
    await page.waitForSelector('.nav-feedback', { timeout: 2_500 }).catch(() => {});
    return page.evaluate(() => !!document.querySelector('.nav-feedback'));
  };
  const clearNavFeedback = () => page.evaluate(() => {
    document.querySelectorAll('.nav-feedback').forEach((n) => n.remove());
  });
  const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
  const modifiedClick = async (x, y) => {
    await page.keyboard.down(MOD_KEY);
    await page.mouse.click(x, y);
    await page.keyboard.up(MOD_KEY);
  };
  const bubbleShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-bubble'));
  const pillShown = () => page.evaluate(() => !!document.querySelector('.terminal-comment-selection-hint'));
  // The pill appears on a 120ms debounce after the selection settles.
  const awaitPill = async () => {
    await page.waitForSelector('.terminal-comment-selection-hint', { timeout: 3_000 }).catch(() => {});
    return pillShown();
  };
  const closeBand = async () => {
    const close = page.locator('.vb-shell.vb-web .vb-close');
    if (await close.count()) { await close.click(); await sleep(500); }
  };
  const escape = async () => {
    await page.evaluate(() => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await sleep(300);
  };
  // Bottom-most decoration box: the match on the freshly echoed line.
  const lastDecoration = () => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.xterm-decoration')]
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((r) => r.w > 4 && r.h > 2);
    boxes.sort((a, b) => a.y - b.y);
    return boxes[boxes.length - 1] || null;
  });
  // Aim at a word on the echoed OUTPUT row — searched from the bottom so neither
  // the command line that printed it nor a sent comment echoing it is the hit. A
  // DOM Range over the word's own characters gives exact geometry, so this does
  // not depend on knowing the cell width.
  const wordTarget = (needle, word) => page.evaluate(([text, target]) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (let i = rows.length - 1; i >= 0; i--) {
      const rowText = rows[i].textContent || '';
      if (!rowText.includes(text) || rowText.includes('printf') || rowText.includes('[selected]')) continue;
      const col = rowText.indexOf(target);
      if (col < 0) continue;
      // Walk the row's text nodes to the character offset, then measure the word.
      let seen = 0;
      const walker = document.createTreeWalker(rows[i], NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent.length;
        if (seen + len > col) {
          const start = col - seen;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, Math.min(len, start + target.length));
          const r = range.getBoundingClientRect();
          if (!r.width) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rowText: rowText.trim() };
        }
        seen += len;
      }
      return null;
    }
    return null;
  }, [needle, word]);

  try {
    const fileUrl = url.pathToFileURL(path.join(FIXTURES, 'e2e-link-popup.html')).href;

    console.log('a click navigates');
    await runCmd(`echo ${fileUrl}`);
    await sleep(1500);
    const link = await lastDecoration();
    check('the URL is decorated as navigable', !!link, link);
    const lx = Math.round(link.x + link.w / 2);
    const ly = Math.round(link.y + link.h / 2);
    await page.mouse.click(lx, ly);
    await page.waitForSelector('.vb-shell.vb-web.open', { timeout: 10_000 }).catch(() => {});
    let s = await state();
    check('a single click opens the viewer band', s.band, s);
    check('and opens no composer', !s.bubble, s);
    await closeBand();

    console.log('an IDE-bound match waits for ctrl/cmd');
    await runCmd("printf '%s\\n' 'see src/sessions-log.js:213 and isSessionActive for it'");
    await sleep(1200);
    const ideLine = await wordTarget('and isSessionActive for it', 'src/sessions-log.js:213');
    check('the file:line is on screen', !!ideLine, ideLine);
    await clearNavFeedback();
    await page.mouse.click(ideLine.x, ideLine.y);
    check('a plain click on file:line fires no navigation', !(await navFired()));
    check('and opens no viewer band', !(await state()).band);
    await clearNavFeedback();
    await modifiedClick(ideLine.x, ideLine.y);
    check('ctrl/cmd click on file:line navigates', await navFired());

    const symbol = await wordTarget('and isSessionActive for it', 'isSessionActive');
    check('the symbol is on screen', !!symbol, symbol);
    await clearNavFeedback();
    await page.mouse.click(symbol.x, symbol.y);
    check('a plain click on a symbol fires no navigation', !(await navFired()));
    await clearNavFeedback();
    await modifiedClick(symbol.x, symbol.y);
    check('ctrl/cmd click on a symbol navigates', await navFired());
    await clearNavFeedback();

    console.log('the mark and the hit region are the same span');
    // Where the reference lands decides whether its line belongs to it. The
    // cursor is the readout: it turns to a pointer over a match the current
    // modifier state can act on.
    const cursorOver = async (needle, word, held) => {
      const t = await wordTarget(needle, word);
      if (!t) throw new Error(`no row carrying "${word}"`);
      if (held) await page.keyboard.down(MOD_KEY);
      await page.mouse.move(t.x, t.y);
      await sleep(200);
      const cursor = await page.evaluate(() => document.querySelector('.xterm-screen')?.style.cursor || '');
      if (held) await page.keyboard.up(MOD_KEY);
      return cursor;
    };
    // An IDE jump lands on the line, so file:line is one reference end to end.
    const ide = 'and isSessionActive for it';
    check('an IDE path is a target under the modifier', await cursorOver(ide, 'src/sessions-log.js', true) === 'pointer');
    check('and so is its line, the same one reference', await cursorOver(ide, '213', true) === 'pointer');
    check('neither is a target without the modifier', await cursorOver(ide, 'src/sessions-log.js', false) === '');

    // The md viewer opens the document, so the line is not part of what is named.
    await runCmd("printf '%s\\n' 'open README.md:42 now'");
    await sleep(1200);
    const doc = 'open README.md:42 now';
    check('a doc is a target on a plain click', await cursorOver(doc, 'README.md', false) === 'pointer');
    check('and its line is ordinary text', await cursorOver(doc, '42', false) === '');

    console.log('a double click on an IDE-bound match navigates nowhere');
    // The residual collision the modifier gate closes: the first press of a
    // double click is detail 1, so before the gate it armed and navigated on its
    // own release. With nothing armed there is no navigation and no interval to
    // sit out before the word select lands.
    await page.mouse.dblclick(symbol.x, symbol.y);
    check('the word select arms the pill', await awaitPill());
    check('and no navigation fired on the way', !(await navFired()));
    await escape();
    await sleep(200);

    console.log('a double click on navigable output does not comment');
    // A path that does not resolve: it decorates and navigation runs, but nothing
    // opens over the terminal, so the word select is observable in place.
    await runCmd('echo src/nope-does-not-exist.txt');
    await sleep(1500);
    const deadPath = await lastDecoration();
    check('the path is decorated as navigable', !!deadPath, deadPath);
    await page.mouse.dblclick(Math.round(deadPath.x + deadPath.w / 2), Math.round(deadPath.y + deadPath.h / 2));
    check('the double click selected the word instead', await awaitPill());
    check('no composer on a double click over a link', !(await bubbleShown()));
    check('and the comment it feeds marks the path',
      selectedIn(await commentAndSend('k')) === 'src/nope-does-not-exist.txt');

    // One printed line, a fresh word per gesture: re-selecting a range that is
    // already selected fires no selection-change, so the pill would not re-arm.
    // The mark has to be there while the drag is still happening. xterm reports
    // a selection change on mouse UP, and its own selection colour is the one
    // thing that cannot paint a cell carrying its own background (a diff row),
    // so a mark that waited for the event looked like it arrived on release.
    console.log('the mark follows a drag over a row with a background of its own');
    await runCmd("printf '\\033[48;2;19;56;19m%s\\033[0m\\n' '+ added telemetry to the resume path'");
    await sleep(1200);
    const markCount = () => page.evaluate(() => document.querySelectorAll('.terminal-comment-mark').length);
    const dragFrom = await wordTarget('added telemetry', 'added');
    const dragTo = await wordTarget('added telemetry', 'resume');
    if (!dragFrom || !dragTo) throw new Error('no row carrying the coloured diff line');
    await page.mouse.move(dragFrom.x, dragFrom.y);
    await page.mouse.down();
    await page.mouse.move(dragTo.x, dragTo.y, { steps: 6 });
    await sleep(300); // the mark syncs on the next animation frame
    check('the mark is painted while the button is still down', await markCount() > 0);
    await page.mouse.up();
    await sleep(400);
    check('and it is still there after the release', await markCount() > 0);
    await escape();
    await sleep(200);
    check('and gone once the selection is dismissed', await markCount() === 0);

    // Sending a comment is left for last — the message echoes the same words back
    // into the screen, which would confuse the row lookup.
    console.log('a double click on plain output selects a word and offers a comment');
    await runCmd("printf '%s\\n' 'the quick brown fox jumped over the lazy dog'");
    await sleep(1200);
    const at = async (word) => {
      const target = await wordTarget('quick brown fox', word);
      if (!target) {
        console.log('    rows:', JSON.stringify(await page.evaluate(() => (
          [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent || '').trim()).filter(Boolean).slice(-6)
        ))));
        throw new Error(`no row carrying "${word}"`);
      }
      return target;
    };

    const quick = await at('quick');
    await page.mouse.dblclick(quick.x, quick.y);
    check('word select arms the pill', await awaitPill());
    check('and opens no composer on its own', !(await bubbleShown()));

    console.log('typing turns that selection into a comment');
    await focusTerm();
    await page.keyboard.type('x');
    await page.waitForSelector('.terminal-comment-bubble', { timeout: 3_000 }).catch(() => {});
    check('composer opens on the first key', await bubbleShown());
    check('composer is seeded with the typed char', await page.evaluate(() => (
      document.querySelector('.terminal-comment-bubble textarea')?.value === 'x'
    )));
    await escape();
    await page.waitForFunction(() => !document.querySelector('.terminal-comment-bubble'), { timeout: 3_000 }).catch(() => {});
    check('Esc closes the composer', !(await bubbleShown()));

    console.log('Esc hands the next keystroke back to the shell');
    const dog = await at('dog');
    await page.mouse.dblclick(dog.x, dog.y);
    check('the pill is armed', await awaitPill());
    await focusTerm();
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Esc disarms the pill on an unfrozen view', !(await pillShown()));
    await focusTerm();
    await page.keyboard.type('echo back-to-the-shell');
    await page.keyboard.press('Enter');
    await sleep(700);
    const after = await page.evaluate(() => (
      [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent || '').trim()).filter(Boolean)
    ));
    check('the keystrokes reached the shell, not a comment',
      after.some((row) => row === 'back-to-the-shell'), after.slice(-4));

    // Sending comes last per line: the sent message echoes the same words back.
    console.log('the comment carries exactly what was selected');
    const brown = await at('brown');
    await page.mouse.dblclick(brown.x, brown.y);
    check('the pill arms on the word', await awaitPill());
    check('a word comment marks that word', selectedIn(await commentAndSend('k')) === 'brown');

    console.log('a triple click takes the whole line');
    await runCmd('clear');
    await runCmd("printf '%s\\n' 'the quick brown fox jumped over the lazy dog'");
    await sleep(1200);
    const lazy = await at('lazy');
    await page.mouse.click(lazy.x, lazy.y, { clickCount: 3 });
    check('line select arms the pill', await awaitPill());
    check('a line comment marks the whole line',
      selectedIn(await commentAndSend('k')) === 'the quick brown fox jumped over the lazy dog');
  } finally {
    await app.close();
  }

  console.log(`\n--- Results: ${passed} passed, ${failures.length} failed ---`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
