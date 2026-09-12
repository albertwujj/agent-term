# Develop AgentTerm

The app runs from a source checkout, and every window it opens takes the current state of that checkout. [Install](install.md) covers getting the first one running on each platform; this page is the loop after that.

## The edit loop

Edit in the source checkout, then press `Ctrl/Cmd+Shift+N` in AgentTerm. The new window takes a fresh source snapshot and rebuilds every generated bundle before it opens, so it runs your edit; close the old window once you have moved over. A build that fails stops that launch and says so, leaving the window you were working in untouched.

If `package.json` or `package-lock.json` changes, no relaunch is enough: run `npm ci`, then the platform's start command again, so the dependency tree matches the lockfile. AgentTerm says so itself: a drifted lockfile prints an `[agent-term warn EDEPSTALE]` line into the terminal the window opens, and a package the launch path loads, meaning anything in `dependencies` plus `esbuild`, stops the launch with a window of its own. A missing packaging or test dependency (`electron-builder`, `jsdom`, `playwright-core`) is not checked at all: the window runs without them, and the suites report their own. `npm run start` builds first, so a package the build itself needs fails there, in the shell you typed it in, before any window exists.

## Logs

A window opened from inside the app (`Ctrl/Cmd+Shift+N`, or "Start or resume session" on its taskbar button or Dock tile) has no console attached, so Node's own stdout and stderr are redirected to `logs/console-<time>-<pid>-<n>.log` under the app's user-data directory (`~/Library/Application Support/agent-term` on macOS, `%APPDATA%\agent-term` on Windows), which every launch prunes of anything older than a week. The window prints a pointer to that file once it has anything in it. Each file is also capped at 4 MB: `main-<pid>.log` rotates to `.old`, while the console file, whose descriptor belongs to the window's stdout and cannot be reopened, is trimmed in place to its most recent output, and the first trim says so in the terminal. A window started from a shell keeps that shell's console instead, and the respawn after the last window closes inherits whichever the closing window had, so a window's output stays with its own lineage.

## Builds and tests

Run builds and tests from the source checkout:

```bash
npm run build
npm run test:all
npm run test:e2e
```

On Windows these commands use WSL Node.js. The end-to-end suite launches Linux Electron and therefore requires WSLg; the non-E2E suite does not.

## User docs

The pages under `docs/` are for a person deciding whether to try something and for the moment they first use it. Two rules keep them readable:

- **Name the capability; do not narrate the UI.** Say what can be done in words a reader can carry to the screen ("copy takes the section under the heading you clicked"), and leave the labels, hints, key lists, and messages to the UI itself, which shows them at the moment they matter. A quoted button label, a flash, a hint's wording, or a step-by-step of a dialog is a sign the sentence should go. Images may show UI; prose does not describe what an image shows.
- **A feature change edits the sentence that names it.** Adding a paragraph for each refinement is how a page grows past reading. If the capability changed, change its sentence; if only the UI changed, the doc usually needs nothing.

The test for a sentence: could a reader who has never opened the app tell what to look for, and would they learn nothing more from it once the app is open?

