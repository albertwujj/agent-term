---
name: verify
description: Drive the real Electron app headlessly with Playwright to verify renderer changes (md viewer, terminal, viewer bands) by screenshot.
---

# Verifying agent-term changes in the real app

Build first (`npm run build`), then launch the shipped app via Playwright's
Electron driver. Pattern lives in `test/e2e/freeze-focus.mjs`; a fuller
md-viewer drive (click → edit → commit → send, screenshot per stage) was
session-scratch — copy the recipe below.

## Launch

```js
import { _electron as electron } from '<abs-path>/node_modules/playwright-core/index.mjs';
const app = await electron.launch({
  executablePath: process.platform === 'darwin'
    ? '<abs-path>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    : '<abs-path>/node_modules/electron/dist/electron', // Linux, incl. WSL
  args: ['--no-sandbox', '<abs-path-to-repo>'],
});
const page = await app.firstWindow();
await page.waitForSelector('.xterm-helper-textarea', { timeout: 30_000 });
```

Under WSL the window opens through WSLg (`DISPLAY=:0`).

Import playwright-core by absolute path — scripts outside the repo can't
resolve it by name. Resize via `app.evaluate(({BrowserWindow}) => ...
setSize(1750, 980))` only AFTER the terminal selector appears (earlier, the
window is still navigating and evaluate throws).

## Gotchas that cost time

- **Session picker opens on launch.** Press Escape once ("esc skip") before
  typing, or keys land in the picker, not the shell.
- **Open an md doc via the terminal harvest**: `echo <bare-path>.md` then
  `webContents.send('open-recent-viewer-url')`. Bare path, NOT a file://
  URL — `file://` classifies as a web entry and opens the web viewer
  (`viewer-history.js` `extractViewerCandidateMatches`). Long paths must not
  line-wrap (hence the wide window) or the harvest misses them.
- **Viewer chords don't fire from `page.keyboard`.** Cmd/Ctrl+Shift+U/I/O
  are caught in main's `before-input-event` (`getViewerShortcutAction`),
  which Playwright's synthetic keys never reach. Send the action instead:
  `app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]
  .webContents.send('viewer-shortcut', 'selector'))` (`'size'`, `'toggle'`
  for I and O). Selector rows: `.at-vsel-row`, with `.at-vsel-tag` and
  `.at-vsel-key`; filter via `.at-vsel-input`.
- Wait target for the md viewer: `.vb-shell.vb-md.open`, then
  `.md-viewer-body h1`.
- A review renders before it shows, so the web band (`.vb-shell.vb-web`)
  can still show the previous page for seconds after a pick. Poll the
  `<webview>`'s `getURL()` for the package's `.html` for up to ~20s; its
  `src` attribute does not follow navigation, and a fixed sleep reads the
  old page.
- Click at a text position: compute the rect with a collapsed Range over
  the block's text nodes in `page.evaluate`, then `page.mouse.click(x, y)` —
  the viewer maps click → caret via caretRangeFromPoint.
- BOTH spread panes hold a copy of every block, and the first
  querySelectorAll match is often below the left page's fold — the click
  silently hits the pane and nothing happens. Iterate the copies and pick
  the one `document.elementFromPoint(x, y)` confirms is really there.
- Screenshot each stage to files and READ the images; the visual defects
  are the findings, DOM assertions alone miss them.
- The md viewer's editing flow is also testable headlessly in jsdom
  (`test/markdown-editing.test.js`) — logic there, pixels here.

## Cleanup

Restore any scratch doc you edited and delete its sidecar
`.NAME-comments.json` between runs, or state leaks into the next drive.
