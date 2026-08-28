const { app, BrowserWindow, ipcMain, nativeTheme, Menu, dialog, clipboard, shell, nativeImage, screen, globalShortcut, session } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { commentHeader } = require('./comment-format');
const { mdStorePosixPath, uncFromPosix } = require('./md-thread-store');
const net = require('net');
const pty = require('node-pty');
const {
  getCaretDiagnostics,
  getCaretPosition,
  navigateToFile,
  navigateToSymbol,
} = require('./navigation');
const {
  shouldInsertCaretPositionShortcut,
  shouldShowCaretDiagnosticsShortcut,
} = require('./caret-shortcut');
const { getViewerShortcutAction } = require('./viewer-shortcut');
const { createPromptCapture } = require('./prompt-capture');
const promptThumbnail = require('./prompt-thumbnail');
const dwm = require('./dwm-thumbnail');
const sessionsLog = require('./sessions-log');
const guiSession = require('./gui-session');
const lockStatus = require('./lock-status'); // pure lock-icon decision (agent-lock)
const jobWatch = require('./job-watch'); // pure background-job monitor logic (job-events.md)
const {
  ICON_OKLCH_L,
  ICON_OKLCH_C,
  ICON_LETTERS_N,
  TASKBAR_TITLE_REST_MAX,
  firstLettersAndRest,
  letterCandidates,
  iconRenderScript,
  truncatePathsForTaskbar,
  extractPathsAndUrls,
  splitChromeTopAndOverflow,
} = require('./icon-render');
const windowCap = require('./window-cap');
const cliIcons = require('./cli-icons');
const { pickNextHue } = require('./hue-assign');
const {
  relaunchAndExit,
  relaunchPortableAndExit,
  resolveLatestRelaunchTarget,
  spawnNewInstance,
} = require('./relaunch');
const { rebuildRuntimeBundles } = require('./runtime-build');
const { StreamClient } = require('./stream/client');
const { StreamState } = require('./stream/stream-state');
const { cleanAiTitle, aiTitleDedupeKey } = require('./ai-title');
const { isReviewPackagePath } = require('./review-package-path');
const {
  journalPathForStore,
  parseJournal,
  mergeStoreWithJournal,
  threadHasAgentEvents,
} = require('./agent-journal');
const { decideStall, unaddressedCount, STALL_IDLE_MS } = require('./comment-stall');
const {
  orderedRunbookCandidates,
  repoRunbookRoots,
} = require('./runbook-resolution');
const {
  bashLauncher,
  wslCommandArgs,
  wslShellArgs,
} = require('./wsl-launch');
const { requireSourceStartCwd } = require('./source-start-cwd');

// Anchor for the very first session ever (when there are no other live
// sessions to space against). 210° = sky/cyan at the L=65 / C=0.27 ring,
// a friendly productivity-tool primary. Subsequent sessions still use
// max-min around it.
const START_HUE = 210;

// Known AI CLIs we can detect from a typed shell command (claude, codex, etc.).
// First match wins; "gh copilot" is checked before bare "copilot" so the longer
// form takes precedence.
const CLI_PATTERNS = [
  { name: 'copilot', re: /^gh\s+copilot(?:\s|$)/i },
  { name: 'claude',  re: /^claude(?:\s|$)/i },
  { name: 'codex',   re: /^codex(?:\s|$)/i },
  { name: 'copilot', re: /^copilot(?:\s|$)/i },
  { name: 'agent',   re: /^agent(?:\s|$)/i },
  { name: 'agent',   re: /^cursor-agent(?:\s|$)/i },
];

function detectCli(cmd) {
  const trimmed = (cmd || '').trim();
  for (const p of CLI_PATTERNS) {
    if (p.re.test(trimmed)) return p.name;
  }
  return null;
}


// Sizes for the DWM iconic thumbnail and live preview bitmaps. Thumbnail size
// matches Windows 11 default; live preview is a clean 16:9 large enough to look
// crisp during Aero Peek without waste.
// Iconic thumbnail bitmap size. MUST be ≤ 200×200 pixels per the
// DwmSetIconicThumbnail API contract — bitmaps exceeding that get
// E_INVALIDARG when pushed inside a WM_DWMSENDICONICTHUMBNAIL handler
// (the previous eager-push pattern silently tolerated bigger bitmaps,
// but the hook-based pattern is strict). 200×112 = 16:9 aspect within
// the hard limit. On HiDPI displays the thumbnail will be upscaled to
// physical size and may appear soft; that's an unavoidable trade-off
// of DWM's 200×200 constraint on the thumbnail-specific bitmap.
const THUMB_W = 200;
const THUMB_H = 112;
// Live-preview bitmap dimensions are now DYNAMIC — set per push to match
// the window's actual content bounds (see renderAndPushIconicBitmaps).
// Static 640/720/1280 sizes all produced liveOk=true but DWM silently
// declined to display them on Win11. Matching the source-window size
// exactly removes the only ambiguous variable in the MSDN constraint
// ("bitmap must not exceed source window").

// PyCharm Navigator Plugin connection settings
const NAVIGATOR_HOST = '127.0.0.1';
const NAVIGATOR_PORT = 8765;
const FRONTEND_PORT = 8766;

// Log to both terminal and renderer DevTools
function log(...args) {
  console.log(...args);
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('main-log', args.join(' '));
  }
}

let mainWindow;
let ptyProcess;
let userClosed = false;
let relaunchStarted = false;
// The real OS color scheme, captured before we force the app's UI dark. The
// embedded web viewer emulates this for guest pages so they render the way they
// do in a normal browser instead of inheriting our dark.
let guestColorScheme = 'light';

function notifyResumeHintSubmit() {
  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('resume-hint-submit');
    }
  } catch {}
}

// --- Per-window taskbar icon ---
// Recipe: pure colored rounded square + faint inset top highlight; hue advances
// 24 degrees per session in OKLCH (perceptually uniform — equal-feeling step
// across the wheel, unlike HSL which jumps in the red->yellow band).
// 15 perceptually-distinct hues per full rotation; cycle repeats every 15 sessions.
//
// Lock-on-first-OSC-title rule: the icon is generated once, on the first usable
// terminal title, then frozen for the lifetime of the window. The session index
// (and therefore hue) comes from a monotonic on-disk counter shared by all
// Agent Term instances, so the user can memorize "this orange one is the auth
// refactor" and that mapping never shifts.
//
// Design history & alternative recipes considered:
//   scripts/preview-variants.js   — per-session secondary cues (shape/split/corner)
//   scripts/preview-aesthetic.js  — surface treatments (flat/linear/radial/inset)
const ICON_HUE_STEP = 24;
// ICON_OKLCH_L / ICON_OKLCH_C / ICON_LETTERS_N / iconRenderScript /
// firstLettersAndRest live in src/icon-render.js (so the preview script can
// share the exact production renderer).

let sessionIndex = null;
let iconLocked = false;
let lockedTitle = null;
let lockedHue = null;
let sessionStartTime = null;
let tooltipInterval = null;
let firstPrompt = null;
// Session subject carried over from a resumed session's stored value
// (written by the retired `initial:true` promotion). New sessions no longer
// mint one: the verbatim first prompt is the intentional frozen identity,
// and the CLI title is captured as drifting title events — the picker shows
// the latest. Kept for identity fallback on resumed sessions that predate
// prompt capture, and so their stored subject keeps rendering.
let initialTitle = null;
// Boot vocabulary: dedupe keys of every OSC title seen before the first
// prompt. A session title worth logging is, by definition, something the
// CLI could not have said before it saw a prompt — so anything in this set
// (brand banners like "✳ Claude Code", shell noise, and their spinner-frame
// variants) stays out of the title event log. CLI-agnostic by construction:
// no per-CLI knowledge needed here.
const bootTitleKeys = new Set();
// Dedupe key of the last title event appended to the sessions log. OSC
// titles arrive per spinner frame ("✳ Fix bug" / "✻ Fix bug" …); gating
// appends on the semantic key keeps the log one-event-per-subject-change.
let lastTitleEventKey = null;
let promptCapture = null;
let streamClient = null;
let streamState = null;
const hiddenPromptSearches = new Map();
let dwmIconicEnabled = false;
let detectedCli = null;
let activeFileWritten = false;
// Resume flow: when a past session is picked, arm this flag. The user's
// first \r keystroke is intercepted and replaced with a "/resume" submission
// — the user's Enter serves as the "CLI is ready for input" timing signal.
// Any non-Enter input cancels the intercept (user is typing their own
// thing). The visual resume hint already tells them what to filter for —
// this just saves them the /resume keystrokes when they're ready.
let pendingResumeIntercept = false;
// Submit timing: write body, wait until the CLI ECHOES output (proving
// it's read the body and rendered a frame — therefore back at its read
// loop), then send CR after a small post-echo margin. The CR lands in
// its own PTY read because the CLI is between reads, not mid-render.
//
// This is adaptive — fast CLIs submit in ~30-130ms, slow CLIs wait as
// long as they need. A fallback timer fires the CR after FALLBACK_MS
// if no echo is ever observed (CLI not echoing, or in alt-screen
// transition that swallows the echo).
const SUBMIT_POST_ECHO_MS = 100;     // margin after echo before CR
const SUBMIT_FALLBACK_MS = 1500;     // outer bound if no echo seen

// Resume submission is always user-driven (Enter after picker-pick →
// the pty-input intercept calls writeAsSubmission('/resume')). No
// auto-fire — every CLI we support has its own quirks that defeat
// reliable output-pattern readiness detection, and a 1-keystroke
// human-in-the-loop check is both simpler and more robust.

function writeBodyThenSubmit(body, terminator = '\r') {
  if (!ptyProcess || typeof body !== 'string' || !body) return false;
  const tBeforeBody = lastPtyOutputTime;
  try { ptyProcess.write(body); } catch (e) {
    log('[submit] body write FAILED: ' + (e && e.message));
    return false;
  }
  const t0 = Date.now();
  let crSent = false;
  const sendCR = (reason) => {
    if (crSent || !ptyProcess) return;
    crSent = true;
    clearInterval(echoTimer);
    clearTimeout(fallbackTimer);
    try { ptyProcess.write(terminator); }
    catch (e) { log('[submit] CR FAILED: ' + (e && e.message)); return; }
    log('[submit] terminator sent (' + reason + ') @ ' + (Date.now() - t0) + 'ms');
  };
  // Poll for an echo every 30ms. Echo = lastPtyOutputTime advanced
  // since we started, meaning the CLI has read the body and emitted
  // at least one byte (typically the rendered input field update).
  const echoTimer = setInterval(() => {
    if (lastPtyOutputTime > tBeforeBody) {
      clearInterval(echoTimer);
      setTimeout(() => sendCR('echo'), SUBMIT_POST_ECHO_MS);
    }
  }, 30);
  // Outer-bound fallback: send CR even if no echo was observed, so a
  // CLI that doesn't echo (or echoes invisibly) still gets a submit.
  const fallbackTimer = setTimeout(() => sendCR('fallback'), SUBMIT_FALLBACK_MS);
  return true;
}

// Write `body`, wait for the CLI to echo (proving the body was read +
// rendered), then send a CR-as-submit. Adaptive — fast CLIs finish in
// ~130ms, slow ones wait until they're ready. Used by the resume
// intercept and the remote-input drain.
function writeAsSubmission(body) {
  return writeBodyThenSubmit(body);
}

function normalizeInlineCommentSubmission(body) {
  if (typeof body !== 'string') return '';
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Do not allow user/comment text to terminate bracketed paste mode.
    .replace(/\x1b/g, '')
    .trim();
}

function writeAsBracketedPasteSubmission(body) {
  const text = normalizeInlineCommentSubmission(body);
  if (!text) return false;
  return writeBodyThenSubmit(`\x1b[200~${text}\x1b[201~`);
}

// CLIs verified LIVE to treat a bare LF (Ctrl+J) as insert-newline in their
// composer. For these, To prompt sends its two separator newlines AFTER the
// closing paste bracket, so the cursor visibly sits on its own line below
// the [Pasted text] chip instead of gluing to it. For every other CLI the
// newlines ride INSIDE the bracket — bracketed-paste content is inert text
// in any TUI, where a bare LF could mean submit and would fire the batch
// early. Same wire format either way: batch, blank line, the user's words.
// Verify a CLI (paste, write '\n', watch: newline or submit?) before adding
// it here. claude: 2.1.241; agent (cursor-agent): 2026.08.11-e8db854;
// codex: 0.144.6 — all live, 2026-08-23.
const LF_INSERTS_NEWLINE_CLIS = new Set(['claude', 'agent', 'codex']);

// "To prompt": the same message, pasted into the CLI's input and left there
// for the user to finish — no CR. The renderer is told so it can roll the
// viewer up and focus the terminal: the user is about to type there.
function writeAsBracketedPasteToPrompt(body) {
  const text = normalizeInlineCommentSubmission(body);
  if (!text || !ptyProcess) return false;
  const lfSafe = LF_INSERTS_NEWLINE_CLIS.has(detectedCli);
  // The separator LFs must be a SEPARATE write, after the CLI has echoed the
  // paste: claude drops the whole paste when the LFs share its chunk. Same
  // echo-then-finish pattern as a submission, with LFs instead of the CR.
  const ok = lfSafe
    ? writeBodyThenSubmit(`\x1b[200~${text}\x1b[201~`, '\n\n')
    : (() => {
        try { ptyProcess.write(`\x1b[200~${text}\n\n\x1b[201~`); return true; } catch (e) {
          log('[to-prompt] body write FAILED: ' + (e && e.message));
          return false;
        }
      })();
  if (!ok) return false;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('to-prompt'); } catch {}
  return true;
}

// One writer for every comment send: submit, or hand to the prompt.
function pasteCommentMessage(body, { toPrompt = false } = {}) {
  return toPrompt ? writeAsBracketedPasteToPrompt(body) : writeAsBracketedPasteSubmission(body);
}

// One finisher for every user-initiated agent ping (inline comment, review
// send, review banner nudge, md pointer): paste, then the bookkeeping the
// paste implies — the prompt went to a live CLI, so a still-armed resume
// intercept is stale; the click was real engagement (window cap); and the
// typing suppression releases so the progress bar can show the pickup.
function pasteAgentPing(body, { toPrompt = false } = {}) {
  if (!pasteCommentMessage(body, { toPrompt })) return false;
  pendingResumeIntercept = false;
  lastInputTime = Date.now();
  lastTypingTime = 0;
  lastInputByte = '';
  return true;
}

// "AI working" indicator state — drives the taskbar progress bar.
let lastPtyOutputTime = 0;
// The "agent active" signal the job-done nudge gates on. Fed by the stream
// pipeline's screen watcher (renderer-watch.js), not the raw byte clock
// above: only a SUBSTANTIAL screen change — real content, judged by
// isSubstantialChange in stream/encoder.js — counts, so spinner frames,
// token counters, and a status line clearing don't read as the agent
// waking. (A CLI clearing its task-stats line at the exact moment a
// background job finished is what used to consume the job's completion
// notice as superseded.) Changes within USER_QUIET_MS of a keystroke are
// the CLI echoing the composer, not the agent — see noteAgentScreenActivity.
let lastAgentOutputTime = 0;
// When this window's shell came up: a job that finished earlier counts as
// finishing now for the nudge's quiet period (job-watch.js).
let ptyStartedAt = 0;
let progressBarOn = false;
let progressInterval = null;
// PTY quiet for >this → considered idle (no progress bar / isWorking=false
// in stream snapshots). Bumped from 1.5s to 5s because Claude's "thinking"
// phase produces output sporadically — token counters update every ~2s
// with pauses in between. At 1.5s the viewer flickered "your turn" between
// updates; 5s smooths that out without making the progress bar noticeably
// stale after work actually stops.
const PROGRESS_IDLE_MS = 5000;
const PROGRESS_POLL_MS = 500;
// UX rule: while the user is at the keyboard composing a prompt, suppress
// the progress bar — distraction outweighs status info, even if the AI is
// genuinely working on a previous turn. Detection: "≤ USER_QUIET_MS since
// last *composing* keystroke." The window covers normal mid-prompt
// thinking pauses. Submit (plain Enter, not preceded by `\`) explicitly
// resets the timer so the bar fires the moment the AI starts responding.
//
// Tracked separately from `lastInputTime` (which the window-cap uses to
// score this window as "active here"): on submit-Enter we want the cap
// to consider the user MORE engaged (they just did something purposeful)
// while wanting the progress-bar to consider them LESS engaged (they're
// now watching AI, not typing). Same keystroke, opposite semantics.
const USER_QUIET_MS = 5000;
let lastTypingTime = 0;
// The prompt box belongs to the user from their first composing keystroke
// until they submit (lastTypingTime resets to 0 on submit-Enter). Host
// injections (job notices, branch warnings) hold during that span — a
// paste mid-compose would splice into their text and the auto-CR would
// submit the fragment.
//
// "Composing" is a STATE, not an age. lastTypingTime resets to 0 on a submit,
// so a non-zero value already means typed-and-not-yet-submitted; the old
// 30-minute stale-out on top of it was a clock answering a question the clock
// cannot see. It cannot tell an abandoned half-prompt from a coffee break, and
// it failed in the direction that costs the user: step away mid-sentence, come
// back past the bound, and a notice has been pasted into the line you were
// writing. Holding instead costs a late notice, and the notice is queued, not
// dropped — it lands on the next submit.
//
// The other hazard the bound covered — terminal-protocol auto-responses
// bumping the timer with no human present — is handled at the source
// (isAutoTerminalProtocol gates the bump). The compositions that end WITHOUT a
// submit clear the flag themselves (Ctrl+C / Ctrl+U below), so the hold cannot
// latch on a line the user already wiped.
function userComposing() {
  return lastTypingTime > 0;
}
// Backslash-Enter (`\<Enter>`) is treated as newline by many AI CLIs (Claude
// Code at minimum) — the user is still composing, not submitting. We watch
// the byte immediately preceding `\r` so backslash-Enter keeps the typing
// timer alive. Other newline conventions (Shift+Enter, Alt+Enter via xterm
// modifyOtherKeys) look like plain `\r` to us and will be classified as
// submits — false-positive surface area is small since `\<Enter>` is the
// common convention.
let lastInputByte = '';
// Window-cap state: hidden flag, last user input time (any keystroke from
// the renderer), the periodic refresh timer for active-file timestamps,
// the cap-control file watcher teardown function, and the once-a-minute
// health timer (ghost check + idle close).
let windowHidden = false;
let lastInputTime = Date.now();
let lastPromptTime = 0;
let activityRefreshInterval = null;
let capControlWatcherTeardown = null;
let healthCheckInterval = null;
// The compositor session our window was created in, resolved once and then
// frozen. Freezing is the point: if WindowServer restarts under us the window
// is gone and this process is a ghost, so re-reading would let it re-certify
// itself as live. Null off macOS — see src/gui-session.js.
let ownGuiSession;
function getOwnGuiSession() {
  if (ownGuiSession === undefined) ownGuiSession = guiSession.currentGuiSession();
  return ownGuiSession;
}

function readAndIncrementCounter() {
  const dir = app.getPath('userData');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, 'icon-counter');
  let n = 0;
  try { n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0; } catch {}
  try { fs.writeFileSync(file, String(n + 1)); } catch {}
  return n;
}

function isUsableTitle(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 4) return false;
  if (/^[~/]/.test(t)) return false;                  // raw path
  if (/[@:].*[$#>]\s*$/.test(t)) return false;        // shell prompt-ish
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+/.test(t)) return false; // user@host
  return true;
}

// Which string drives the taskbar icon letters + window-title rest?
// Prefer the verbatim first prompt — it's what the user typed and what
// they recognise. Falls back to `initialTitle` (CLI-distilled subject)
// only when no prompt has been captured yet (pre-first-Enter state).
// Verbatim prompts often contain URLs / paths / @-mentions; callers
// should run them through truncatePathsForTaskbar before splitting.
function identityString() {
  return firstPrompt || initialTitle || '';
}

function cycleIconParams(idx) {
  return {
    hue: (idx * ICON_HUE_STEP) % 360,
  };
}

// Renders the icon and returns { img, n } where n is the actual letter count
// the canvas chose to draw (3 or 4 — whichever fit at the target font size
// without truncation). The caller uses n to keep the window-title "rest"
// in sync with the icon, so the same character never appears in both.
async function makeIconImage(hue, prompt) {
  if (!mainWindow || !mainWindow.webContents) return null;
  const candidates = letterCandidates(prompt);
  const raw = await mainWindow.webContents.executeJavaScript(iconRenderScript(hue, candidates));
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || !parsed.url) return null;
  const img = nativeImage.createFromDataURL(parsed.url);
  if (img.isEmpty()) return null;
  return { img, n: parsed.n || ICON_LETTERS_N };
}

// Render the CLI brand icon (Claude / Codex / Copilot / Cursor) as a
// 256×256 PNG NativeImage suitable for mainWindow.setIcon. Used pre-prompt
// — before the user has typed anything, the session has no hue identity
// yet, so the taskbar carries the brand of the running CLI. Returns null
// for unknown CLIs (caller leaves Electron's default app icon in place).
async function makeBrandIconImage(cli) {
  if (!mainWindow || !mainWindow.webContents) return null;
  const script = cliIcons.brandIconScript(cli);
  if (!script) return null;
  const raw = await mainWindow.webContents.executeJavaScript(script);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || !parsed.url) return null;
  const img = nativeImage.createFromDataURL(parsed.url);
  if (img.isEmpty()) return null;
  return { img };
}

function relativeTime(ageMs) {
  const m = Math.floor(ageMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatTooltip() {
  if (!sessionStartTime) return '';
  // Prefer the verbatim user prompt; fall back to the OSC title.
  const body = firstPrompt || lockedTitle;
  if (!body) return '';
  return `${body}\n\nStarted ${relativeTime(Date.now() - sessionStartTime)}`;
}

function refreshTooltip() {
  if (!iconLocked || !mainWindow) return;
  try { mainWindow.setThumbnailToolTip(formatTooltip()); } catch {}
}

// Single source of truth for the "AI working" flag used by the taskbar
// progress bar, the chrome-bar dot, and the thumbnail header. Requires:
//   · A CLI is locked (so shell-only output never fires).
//   · PTY produced output recently (within PROGRESS_IDLE_MS).
//   · User isn't at the keyboard (within USER_QUIET_MS of the last
//     keystroke). Submit-Enter resets lastInputTime to 0 so this check
//     passes immediately after the user hits Enter.
function computeIsWorking() {
  if (!iconLocked) return false;
  const now = Date.now();
  return (now - lastPtyOutputTime < PROGRESS_IDLE_MS)
      && (now - lastTypingTime   > USER_QUIET_MS);
}

// Build the activity-card payload for the thumbnail renderer. Reads recent
// prompts from the session log, builds a body-list excluding firstPrompt
// (it lives in the header, not the body), and reflects the live working
// state plus the CLI-emitted title pair. Pure data — the canvas script
// lives in prompt-thumbnail.js.
function thumbnailPayload() {
  const isWorking = computeIsWorking();
  const userDataDir = app.getPath('userData');
  let logEntries = [];
  if (sessionIndex !== null) {
    try {
      logEntries = sessionsLog.getRecentPromptsForSession(userDataDir, sessionIndex);
    } catch {}
  }
  const allPrompts = logEntries.filter(p => p && p.prompt);
  // Body list (small thumbnail) shows recent prompts newest-first, EXCLUDING
  // firstPrompt — it lives in the header and shouldn't appear again below.
  const recentPrompts = allPrompts.slice().reverse().filter(p => p.prompt !== firstPrompt);
  // Live-preview timeline: chronological merge of prompts + titles. Titles
  // are filtered to those AFTER firstPrompt's timestamp (boot-banner titles
  // aren't part of the session's narrative) and deduped against repeats.
  // Each event carries a type so the renderer can style prompts vs titles
  // differently — they're independent streams, not 1:1, so we show them
  // interleaved by their natural timing rather than glued together.
  const firstPromptTime = allPrompts.length > 0 ? allPrompts[0].t : 0;
  let allTitles = [];
  if (sessionIndex !== null && firstPromptTime > 0) {
    try {
      allTitles = sessionsLog.getRecentTitlesForSession(userDataDir, sessionIndex, {
        afterTime: firstPromptTime,
      });
    } catch {}
  }
  // AI CLIs commonly emit OSC titles that echo the user's prompt — Claude
  // Code et al. use the title bar as a "current task" indicator and set it
  // to the prompt text when work begins. Those titles show up at multiple
  // timestamps (the CLI alternates between sub-task and high-level task
  // titles), so they can land between subsequent prompts in the activity
  // timeline and read as a duplicate of firstPrompt — violating the
  // chrome top / thumb body / live preview "no repetition" principle.
  // Drop them at the events-build step after normalizing away spinner
  // prefixes, CLI brand labels, and duplicate dot-separated title chunks.
  // This handles raw OSC variants like "Claude Code · X · X" vs "✳ X"
  // as the same semantic title.
  const titleSeen = new Set();
  const fpEchoKey = aiTitleDedupeKey(firstPrompt || '', detectedCli);
  const itEchoKey = aiTitleDedupeKey(initialTitle || '', detectedCli);
  if (fpEchoKey) titleSeen.add(fpEchoKey);
  if (itEchoKey) titleSeen.add(itEchoKey);
  const filteredTitles = [];
  for (const t of allTitles) {
    const cleanTitle = cleanAiTitle(t.title || '', detectedCli);
    const key = aiTitleDedupeKey(cleanTitle, detectedCli);
    if (!key || titleSeen.has(key)) continue;
    titleSeen.add(key);
    filteredTitles.push({ ...t, title: cleanTitle });
  }
  // Strip URLs / paths / @-mentions from title text in the activity timeline.
  // Even after the echo filter above, AI titles sometimes embed paths/URLs
  // verbatim — those are visual noise next to the prompt and get collapsed
  // for the activity-timeline render. firstPrompt's refs are still surfaced
  // by the live-preview footer (extracted separately below); titles' embedded
  // refs are dropped here without adding to the footer to keep that list
  // focused on the user's own input.
  const events = [
    ...allPrompts.map(p => ({ type: 'prompt', text: p.prompt, t: p.t || 0 })),
    ...filteredTitles.map(t => ({ type: 'title', text: truncatePathsForTaskbar(t.title), t: t.t || 0 })),
  ].sort((a, b) => a.t - b.t);
  // Small-thumbnail activity list: chronological (oldest first), excludes
  // firstPrompt (it's already in the window's chrome bar / taskbar button
  // — don't repeat). The thumbnail renders bottom-up so the newest activity
  // lands at the bottom edge — matches the way the actual terminal scrolls
  // (most recent at bottom) and stays consistent with the chronological
  // live preview layout.
  const recentActivity = events
    .filter(e => !(e.type === 'prompt' && e.text === firstPrompt));
  // Pre-prompt state: no captured prompts yet but we have an OSC title.
  // Use the title as the header's "verbatim" stand-in so the card isn't
  // empty during the brief gap between CLI boot and the user's first Enter.
  const headerText = firstPrompt || lockedTitle || '';
  // Compute "what's NOT visible in the chrome top of the thumbnail popup."
  // We put the first TASKBAR_TITLE_REST_MAX chars of firstPrompt's rest
  // into the window title via setTitle(); everything past that point is
  // what the user can't see at the top of the popup. The card surfaces
  // that overflow so chrome-top + card together cover the whole prompt
  // with no overlap. Same input pipeline as the title (initialTitle when
  // available, else truncatePathsForTaskbar of firstPrompt) so the cut
  // point is consistent.
  let firstPromptOverflow = '';
  // Refs (URLs, ≥3-segment paths, @-mentions) extracted from the verbatim
  // first prompt — surfaced verbatim in the live-preview footer so the
  // user can see what was actually referenced. Always extracted from
  // firstPrompt (not initialTitle) since initialTitle is model-distilled
  // and the refs the user actually wrote live in their literal prompt.
  let refs = [];
  if (firstPrompt) {
    const stripped = extractPathsAndUrls(firstPrompt);
    refs = stripped.refs;
    // firstPrompt-derived identity (verbatim with refs stripped) drives the
    // size-constrained chain: icon letters → window-title chrome → body.
    // The body — the thumb card AND the live-preview top section — both
    // render the SAME overflow text (chars beyond chrome top). They're
    // never visible simultaneously (live preview replaces the thumb), so
    // there's no duplication; the live preview just gets more vertical
    // room before its wrap-and-clip cuts in.
    const titleSource = stripped.text;
    const { rest } = firstLettersAndRest(titleSource, ICON_LETTERS_N);
    const split = splitChromeTopAndOverflow(rest, TASKBAR_TITLE_REST_MAX);
    // Word-boundary cuts read as clean continuations; mid-character
    // fallbacks (taskbar-only, when nothing else fits) get a '…' prefix
    // so the body reads as picking up mid-word from chrome top above.
    // The renderers handle their own pixel-accurate truncation via
    // wrapText + clipWithEllipsis using the same \W word definition —
    // so we hand them the full overflow rather than pre-clipping to a
    // char-count estimate.
    firstPromptOverflow = split.midWord ? '…' + split.overflow : split.overflow;
  }
  return {
    cli: detectedCli || '',
    isWorking,
    firstPrompt: headerText,
    firstPromptOverflow,
    refs,
    recentPrompts,
    recentActivity,
    events,
    initialTitle: initialTitle || '',
    lockedTitle: lockedTitle || '',
    sessionStartTime: sessionStartTime || 0,
  };
}

// Render the thumbnail (small) + live-preview (full-window) bitmaps and
// push them to DWM. Two ideas drive this function's gating:
//   · Suppress while focused. The taskbar preview only matters when the
//     user is NOT looking at this window. Re-rendering on every prompt /
//     working flip while the window is in front is pure waste. We set a
//     pending-render flag and defer until the window loses focus.
//   · Live preview at full window resolution. Matching getContentBounds()
//     removes the only ambiguous variable in the MSDN "must not exceed
//     source window" constraint, and tests whether DWM's silent rejection
//     on Win11 is tied to size-mismatch with the source window.
let renderInFlight = false;
let renderQueued = false;
let pendingRender = false;
let everPushed = false;     // first push always happens regardless of focus
let lastPushedPayloadHash = null;
// Cached BGRA buffers for the iconic-representation bitmaps. Both
// surfaces (thumbnail and live preview) go through their respective
// WM_DWMSEND* hooks rather than being pushed eagerly — that matches
// the Microsoft TabThumbnails canonical pattern and avoids the
// thumbnail-cache vs invalidate footgun (any invalidate call would
// otherwise wipe an eagerly-pushed thumbnail until the next state
// change). Both caches are read synchronously inside the hook callbacks
// when DWM requests the bitmap; CreateDIBSection / DwmSet* / DeleteObject
// all run inside the hook, then DWM keeps its own copy.
// Cached HBITMAPs (Win32 GDI handles), pre-built outside the WM_DWMSEND*
// hooks so the hook callbacks themselves just call DwmSet*Bitmap with the
// already-built handle — no CreateDIBSection or memcpy inside the hot path.
// This minimizes our handler latency, which is the controllable portion of
// the Aero Peek white flash. (The other portion — DWM's transition frame
// before it sends the message — is fundamental and can't be eliminated.)
// We own the lifetime: must DeleteObject the old HBITMAP before replacing,
// and free both on window close to avoid leaking GDI objects.
let cachedThumbHBitmap = null;
let cachedLiveHBitmap = null;
// Dimensions retained alongside the handles for diagnostic logging only —
// the HBITMAP itself carries the actual pixel dimensions internally.
let cachedThumbSize = null;    // { width, height } or null
let cachedLiveSize = null;     // { width, height } or null
// Pre-resolved HWND captured at hook-install time so the hook callback
// doesn't have to call getNativeWindowHandle() on every WM_DWMSEND*
// dispatch. Live preview specifically isn't cached by DWM and the hook
// fires on every Aero Peek hover — saving every microsecond reduces the
// visible flash between transition start and our bitmap arriving.
let cachedHwnd = null;
let iconicHooksInstalled = false;
const WM_DWMSENDICONICTHUMBNAIL = 0x0323;
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326;

// Debug toggle: when true, the iconic hooks short-circuit without pushing
// any bitmap. Per Microsoft docs, if a window doesn't respond to the
// WM_DWMSENDICONIC* messages, DWM displays its generic preview surface —
// the silver-grey backdrop we suspect causes the residual transition
// flash. This switch is for pixel-picking that exact color: toggle ON,
// hover taskbar / engage Aero Peek, screenshot, sample. Toggled via
// Ctrl/Cmd+Shift+F11 (registered in app.whenReady).
let forceFallbackForScreenshot = false;

// Cheap hash of the payload fields that actually drive the rendered bitmap.
// Skipping renders when this is unchanged means redundant triggers (working
// flip that flaps back, repeat title events, etc.) don't burn CPU on a
// guaranteed-identical bitmap.
function payloadHash(p) {
  return JSON.stringify({
    cli: p.cli, isWorking: p.isWorking, firstPrompt: p.firstPrompt,
    events: (p.events || []).map(e => ({ type: e.type, text: e.text, t: e.t })),
    initialTitle: p.initialTitle, lockedTitle: p.lockedTitle,
  });
}

async function renderAndPushIconicBitmaps() {
  if (!mainWindow || !mainWindow.webContents || lockedHue === null) return;
  if (!dwm.isSupported) return;  // no-op on non-Windows; saves the renderer roundtrip
  // Suppress while focused (except for the very first push, which seeds the
  // iconic cache so the user gets *something* if they immediately glance
  // at the taskbar). The on('blur') handler fires the deferred push.
  if (everPushed && mainWindow.isFocused()) {
    pendingRender = true;
    return;
  }
  // Coalesce overlapping calls: we re-render on every prompt + activity flip,
  // but the canvas roundtrip is async. If a call comes in while one is in
  // flight, queue a single re-render after it finishes.
  if (renderInFlight) { renderQueued = true; return; }
  renderInFlight = true;
  pendingRender = false;
  try {
    const payload = thumbnailPayload();
    // Skip the render entirely if nothing that affects the bitmap has
    // changed since the last successful push. Cheap hash compare avoids
    // a couple-hundred-ms canvas roundtrip + DWM marshalling cost. The
    // hash includes the display's scale factor so a window move between
    // monitors of different DPIs invalidates the cache (we'd render at
    // a different physical size).
    let displayScale = 1;
    try {
      const d = screen.getDisplayMatching(mainWindow.getBounds());
      if (d && Number.isFinite(d.scaleFactor) && d.scaleFactor > 0) {
        displayScale = d.scaleFactor;
      }
    } catch {}
    const hash = payloadHash(payload) + '@' + displayScale;
    if (everPushed && hash === lastPushedPayloadHash) {
      return;
    }
    // Live preview matches the window's actual content bounds in PHYSICAL
    // pixels, not logical CSS pixels. DWM's compositor operates in
    // physical pixels; pushing a 1707x912 logical bitmap to a 300%-scaled
    // 5120x2880 display means DWM sees a bitmap that's 1/9 the physical
    // area of the source window and silently doesn't display it (the
    // chip-on-grey fallback). Multiply by the matching display's
    // scaleFactor (3 for 300% scale) so the bitmap dimensions equal the
    // window's actual on-screen pixel count.
    // While the window is minimized to the taskbar, Win32 reports the
    // iconic rect (≈ -32000,-32000 with tiny dimensions) and Electron's
    // getContentBounds() can return zero/negative content size. Falling
    // back to a hard-coded 1280x720 here used to poison the live-preview
    // cache with a small bitmap, which DWM then renders 1:1 in the
    // top-left of the larger Aero Peek frame ("not full screen, smaller,
    // aligned to top left"). Skip the render entirely when bounds are
    // unusable — the last good HBITMAP keeps serving, and the 'restore'
    // / 'resize' / 'move' handlers force a fresh render once the window
    // is back to a normal state.
    if (mainWindow.isMinimized && mainWindow.isMinimized()) {
      return;
    }
    let clientW = 0, clientH = 0;
    try {
      const b = mainWindow.getContentBounds();
      clientW = b.width; clientH = b.height;
    } catch {}
    if (clientW <= 0 || clientH <= 0) {
      log('[thumbnail] skipped — getContentBounds invalid (' +
          clientW + 'x' + clientH + '); keeping previous live-preview cache');
      return;
    }
    // Safety margin against rounding overshoot. Electron's getContentBounds
    // returns integer DIPs (1707 wide on a 5120-physical panel at 300% =
    // logical 1706.67 rounded up). Reconstructing physical via *scale
    // gives 5121 — 1 px wider than the actual 5120 panel-aligned client.
    // DWM's "bitmap must not exceed source window" check rejects that 1-px
    // overshoot silently (HRESULT 0 but no display). Floor + subtract 4
    // keeps us safely under the true physical client size; the visible
    // bitmap is essentially full-screen, a few pixels short of the edge.
    const physicalW = Math.max(1, Math.floor(clientW * displayScale) - 4);
    const physicalH = Math.max(1, Math.floor(clientH * displayScale) - 4);
    // Two complementary views:
    //   · Small thumbnail = at-a-glance status card: identity (firstPrompt)
    //     + most recent activity (newest-first) + distilled titles.
    //   · Live preview   = chronological session "story": prompts and
    //     titles interleaved by time, no elision (just stop drawing when
    //     the canvas fills).
    const thumbScript = promptThumbnail.buildScript({ ...payload, width: THUMB_W, height: THUMB_H });
    // Pass the display's scale factor so the live-preview renderer can
    // pick a font size in canvas pixels that displays at terminal-matching
    // CSS-pixel size on screen (16 CSS px × scaleFactor = canvas px).
    const liveScript  = promptThumbnail.buildLivePreviewScript({
      ...payload,
      width: physicalW,
      height: physicalH,
      displayScale,
      thumbWidth: THUMB_W,
      thumbHeight: THUMB_H,
    });
    const [thumbDataURL, liveDataURL] = await Promise.all([
      mainWindow.webContents.executeJavaScript(thumbScript),
      mainWindow.webContents.executeJavaScript(liveScript),
    ]);
    const thumbImg = nativeImage.createFromDataURL(thumbDataURL);
    const liveImg  = nativeImage.createFromDataURL(liveDataURL);
    if (thumbImg.isEmpty() || liveImg.isEmpty()) {
      log('[thumbnail] empty NativeImage from canvas — thumb url len=' +
          (thumbDataURL ? thumbDataURL.length : 'null') +
          ', live url len=' + (liveDataURL ? liveDataURL.length : 'null'));
      return;
    }
    const hwnd = mainWindow.getNativeWindowHandle();
    if (!dwmIconicEnabled) {
      const enableResult = dwm.enableIconicMode(hwnd);
      dwmIconicEnabled = enableResult.ok;
      log('[thumbnail] enableIconicMode ok=' + enableResult.ok +
          ' has=' + enableResult.has +
          ' force=' + enableResult.force +
          ' disallowPeek=' + enableResult.disallowPeek +
          ' darkMode=' + enableResult.darkMode);
    }
    // Install the iconic-representation message hooks once. DWM sends:
    //   · WM_DWMSENDICONICTHUMBNAIL (0x0323) when it needs the small
    //     thumbnail (cache empty or invalidated).
    //   · WM_DWMSENDICONICLIVEPREVIEWBITMAP (0x0326) on every Aero Peek
    //     hover-into (live preview is never cached).
    // Inside each hook we build a fresh HBITMAP from the cached BGRA and
    // call DwmSet* synchronously. Pushing outside these hooks doesn't
    // work for live preview at all (silently discarded) and would mean
    // an asymmetric eager-push code path for the thumbnail; routing
    // both through their hooks keeps one mental model.
    installIconicHooks();

    const thumbBitmap = thumbImg.toBitmap();
    const liveBitmap  = liveImg.toBitmap();
    const expectedThumb = THUMB_W * THUMB_H * 4;
    const expectedLive  = physicalW * physicalH * 4;
    // Build the HBITMAPs NOW (outside the hooks) so the hook callbacks
    // can push them instantly. Atomic swap: build new, swap into cache,
    // delete previous handles. If a build fails, log and keep the old
    // cache rather than ending up with no bitmap at all.
    const newThumbHBitmap = dwm.buildHBitmap(thumbBitmap, THUMB_W, THUMB_H);
    const newLiveHBitmap  = dwm.buildHBitmap(liveBitmap,  physicalW, physicalH);
    if (newThumbHBitmap && newLiveHBitmap) {
      const oldThumb = cachedThumbHBitmap;
      const oldLive  = cachedLiveHBitmap;
      cachedThumbHBitmap = newThumbHBitmap;
      cachedLiveHBitmap  = newLiveHBitmap;
      cachedThumbSize = { width: THUMB_W,   height: THUMB_H };
      cachedLiveSize  = { width: physicalW, height: physicalH };
      if (oldThumb) dwm.deleteHBitmap(oldThumb);
      if (oldLive)  dwm.deleteHBitmap(oldLive);
    } else {
      if (newThumbHBitmap) dwm.deleteHBitmap(newThumbHBitmap);
      if (newLiveHBitmap)  dwm.deleteHBitmap(newLiveHBitmap);
      log('[thumbnail] buildHBitmap failed thumb=' + !!newThumbHBitmap +
          ' live=' + !!newLiveHBitmap);
    }
    // Tell DWM both cached representations are stale so the NEXT display
    // request goes through our hooks. The hooks now push pre-built
    // HBITMAPs directly — sub-millisecond response.
    const invalidated = dwm.invalidate(hwnd);

    everPushed = true;
    lastPushedPayloadHash = hash;
    log('[thumbnail] cached both HBITMAPs invalidated=' + invalidated +
        ' thumbBytes=' + thumbBitmap.length + '/' + expectedThumb +
        ' liveBytes=' + liveBitmap.length + '/' + expectedLive +
        ' clientLogical=' + clientW + 'x' + clientH +
        ' thumbCachedSize=' + THUMB_W + 'x' + THUMB_H +
        ' liveCachedSize=' + physicalW + 'x' + physicalH +
        ' scale=' + displayScale +
        ' focused=' + (mainWindow.isFocused ? mainWindow.isFocused() : 'n/a'));
  } catch (err) {
    log('[thumbnail] render/push exception: ' + (err && err.message) +
        '\n' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : ''));
  } finally {
    renderInFlight = false;
    if (renderQueued) {
      renderQueued = false;
      // Re-fire so the most recent state (latest prompt / working flip) wins.
      renderAndPushIconicBitmaps();
    }
  }
}

// Register per-message hooks for both DWM iconic-representation
// messages. We use Electron's BrowserWindow.hookWindowMessage (subscribe
// by specific message ID) rather than a koffi-based full WndProc
// subclass for two reasons:
//   · koffi callbacks for cross-thread invocations get queued to the
//     Node main thread — arriving too late to return LRESULT
//     synchronously from WndProc.
//   · A full subclass receives EVERY message (paint, mouse, timers —
//     thousands per second). Per-message hooks fire only when DWM
//     actually needs the bitmap: rare, on-demand.
//
// Inside each callback we build a fresh DIB-section HBITMAP from the
// cached BGRA, call the corresponding DwmSet*Bitmap synchronously, and
// DeleteObject immediately afterwards (DWM makes its own copy per the
// API contract — the Raymond Chen "create / set / delete" pattern).
function installIconicHooks() {
  if (iconicHooksInstalled || !mainWindow) return;
  if (typeof mainWindow.hookWindowMessage !== 'function') return;  // non-Windows
  try {
    // Cache the HWND once now so the hook callbacks don't repeatedly hit
    // getNativeWindowHandle() — that's a Buffer allocation per call, and
    // every microsecond we shave off the live-preview hook reduces the
    // visible flash during Aero Peek transitions.
    cachedHwnd = mainWindow.getNativeWindowHandle();

    // Thumbnail hook — pushes the pre-built thumbnail HBITMAP. No bitmap
    // creation inside the hook, just DwmSetIconicThumbnail with the
    // cached handle. DWM caches the bitmap after our response.
    mainWindow.hookWindowMessage(WM_DWMSENDICONICTHUMBNAIL, () => {
      if (forceFallbackForScreenshot) {
        setImmediate(() => log('[thumb-hook] skipped (forceFallbackForScreenshot=true)'));
        return;
      }
      if (!cachedThumbHBitmap || !cachedHwnd) return;
      const ok = dwm.pushThumbnailHBitmap(cachedHwnd, cachedThumbHBitmap);
      // Defer log so the hook returns to the OS dispatcher promptly.
      setImmediate(() => {
        const s = cachedThumbSize || { width: 0, height: 0 };
        log('[thumb-hook] push ok=' + ok + ' size=' + s.width + 'x' + s.height);
      });
    });
    // Live preview hook — pushes the pre-built live-preview HBITMAP.
    // DWM does NOT cache live preview, so this hook fires on every Aero
    // Peek hover. The pre-built HBITMAP gives us the fastest possible
    // response (sub-millisecond instead of ~10-30ms with CreateDIBSection
    // + memcpy inside the hook).
    mainWindow.hookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP, () => {
      if (forceFallbackForScreenshot) {
        setImmediate(() => log('[live-hook] skipped (forceFallbackForScreenshot=true)'));
        return;
      }
      if (!cachedLiveHBitmap || !cachedHwnd) return;
      const ok = dwm.pushLivePreviewHBitmap(cachedHwnd, cachedLiveHBitmap);
      setImmediate(() => {
        const s = cachedLiveSize || { width: 0, height: 0 };
        log('[live-hook] push ok=' + ok + ' size=' + s.width + 'x' + s.height);
      });
    });
    iconicHooksInstalled = true;
    log('[iconic-hooks] installed for WM_DWMSENDICONICTHUMBNAIL (0x0323) and WM_DWMSENDICONICLIVEPREVIEWBITMAP (0x0326)');
  } catch (err) {
    log('[iconic-hooks] install failed: ' + (err && err.message));
  }
}

async function tryLockIcon(title) {
  if (iconLocked || !mainWindow || !isUsableTitle(title)) return;
  // Gate on detectedCli: only treat an OSC title as "AI CLI booted" when we
  // know a CLI was invoked (either via the picker or typed in shell). Shells
  // often emit OSC titles for the cwd (e.g., "agent-term"), which would
  // otherwise consume a session-index slot for a non-CLI window.
  if (!detectedCli) return;
  iconLocked = true;          // claim the lock synchronously to prevent re-entry while the canvas renders
  lockedTitle = title;
  sessionStartTime = Date.now();

  // Deferred-identity policy: sessionIndex, hue, the active-file entry,
  // the "started" + "cli" log events, and the window-cap machinery do NOT
  // fire here. They wait for onPromptCaptured. Rationale: a CLI window
  // that boots but never gets a prompt shouldn't consume a hue rotation
  // slot or count toward the window cap — it's a transient pre-session.
  // Taskbar identity in this pre-prompt state is the CLI's brand icon
  // (Claude / Codex / Copilot / Cursor); when the first prompt arrives,
  // onPromptCaptured does the deferred work and replaces the brand icon
  // with the chip (letters + hue underline).
  if (detectedCli) {
    (async () => {
      try {
        const result = await makeBrandIconImage(detectedCli);
        if (result && mainWindow) mainWindow.setIcon(result.img);
      } catch {}
    })();
  }

  if (promptCapture) promptCapture.notifyCliStarted();
  // Push the initial activity card (just the title, until prompts arrive).
  renderAndPushIconicBitmaps();
  refreshTooltip();
  if (!tooltipInterval) tooltipInterval = setInterval(refreshTooltip, 60_000);
  syncChromeState();
}

// Once the first prompt arrives, promote the window from "pre-session"
// to a real session: assign a sessionIndex + hue, write the active file,
// append the started/cli/title log events, and turn on the window-cap
// machinery. Idempotent — onPromptCaptured calls this once on the first
// captured prompt; resumeFromSession does its own equivalent setup along
// an inherited path.
// Read the hues of every currently-live session — used as the reference
// set for max-min hue selection. Live = active file present, pid alive,
// bootTime matches. Hue lookup falls through to listSessions (the log
// always has hue from the "started" event), so this works even if the
// active file pre-dates the hue-in-active-file change.
function getActiveSessionHues(userDataDir) {
  try {
    const liveIds = new Set(
      windowCap.listLiveRecords(userDataDir).map(r => r.id),
    );
    if (liveIds.size === 0) return [];
    const out = [];
    for (const s of sessionsLog.listSessions(userDataDir)) {
      if (!liveIds.has(s.id)) continue;
      if (typeof s.hue === 'number') out.push(s.hue);
    }
    return out;
  } catch {
    return [];
  }
}

function assignSessionIdentity() {
  if (sessionIndex !== null && activeFileWritten) return;
  if (sessionIndex === null) sessionIndex = readAndIncrementCounter();
  // Dynamic max-min hue pick: choose the hue furthest from any currently-
  // live session's hue. When there are no concurrent sessions, the very
  // first session ever uses START_HUE (sky/cyan, a productivity-tool
  // primary); subsequent solo sessions fall back to the legacy index-
  // based cycle for backward compatibility.
  const userDataDir = app.getPath('userData');
  const activeHues = getActiveSessionHues(userDataDir);
  const fallback = sessionIndex === 0 ? START_HUE : cycleIconParams(sessionIndex).hue;
  const hue = pickNextHue(activeHues, fallback);
  lockedHue = hue;
  if (!activeFileWritten) {
    sessionsLog.writeActiveFile(userDataDir, sessionIndex, {
      pid: process.pid,
      bootTime: sessionsLog.currentBootTime(),
      guiSession: getOwnGuiSession(),
      token: agentSessionId,
      hue,
      lastInputAt: lastInputTime,
      lastWorkingAt: lastPtyOutputTime,
      lastPromptAt: lastPromptTime,
      hiddenAt: null,
    });
    activeFileWritten = true;
    sessionsLog.appendEvent(userDataDir, { e: 'started', id: sessionIndex, hue, token: agentSessionId });
    if (detectedCli) {
      sessionsLog.appendEvent(userDataDir, { e: 'cli', id: sessionIndex, cli: detectedCli });
    }
    if (lockedTitle) {
      sessionsLog.appendEvent(userDataDir, { e: 'title', id: sessionIndex, title: lockedTitle });
    }
    // The CLI runs as the shell's foreground child, so the shell's cwd is
    // frozen at the directory the CLI was launched from — sample it now
    // (POSIX on both platforms: /proc/<pid>/cwd in WSL, lsof on macOS) so a
    // resume can cd back before relaunching.
    const cwdSessionId = sessionIndex;
    getPrimaryCwd().then((cwd) => {
      if (cwd) sessionsLog.appendEvent(userDataDir, { e: 'cwd', id: cwdSessionId, cwd });
    }).catch(() => {});
    enforceVisibleCap();
    startCapControlWatcher();
    startCapTimers();
  }
}

// Render the taskbar icon (3-4 letter chip + hue pill) and update the window
// title's "rest" from the current identity string (initialTitle ?? firstPrompt).
// Idempotent — safe to call on first-prompt capture, on a grace-window title
// upgrade, or on resume. The icon canvas reports which letter-count candidate
// (3 or 4) it actually drew so the title-rest starts from the matching index.
// macOS window title. The native title bar sits directly above the chrome
// band, which already shows the verbatim prompt (or "waiting for prompt…"),
// so the title must not repeat either. It also can't host the icon-letter
// split (setIcon is a Windows/Linux API). Instead it carries what the band
// doesn't show: the CLI name plus the CLI's latest distilled OSC task title,
// drifting as the session progresses ("claude · Fix window titles"). Before
// the first usable OSC title — or when the title cleans away to nothing
// (brand-only / spinner-only pushes) — it's the CLI name alone.
function macWindowTitle() {
  const subject = cleanAiTitle(lockedTitle || '', detectedCli);
  if (detectedCli && subject) return `${detectedCli} · ${subject}`;
  return detectedCli || subject;
}

// Recompose the darwin title from current state. Returns true when darwin
// owns the title (callers skip their platform-default setTitle), false
// elsewhere. Empty compositions (shell window, nothing locked) leave the
// existing title untouched so shell OSC passthrough survives.
function syncMacWindowTitle() {
  if (process.platform !== 'darwin') return false;
  if (mainWindow) {
    const t = macWindowTitle();
    if (t) { try { mainWindow.setTitle(t); } catch {} }
  }
  return true;
}

function renderIdentityIconAndTitle() {
  const text = identityString();
  if (!mainWindow || !text) return;
  if (syncMacWindowTitle()) return;
  // identityString prefers firstPrompt — the verbatim prompt typically
  // contains URLs/paths/@-mentions that need stripping for the size-
  // constrained surfaces. Only skip stripping in the pre-prompt fallback
  // where text comes from initialTitle (model-distilled, already trim).
  const displayText = (firstPrompt && text === firstPrompt)
    ? truncatePathsForTaskbar(text)
    : text;
  if (lockedHue !== null) {
    (async () => {
      try {
        const result = await makeIconImage(lockedHue, displayText);
        if (result && mainWindow) {
          mainWindow.setIcon(result.img);
          const { rest } = firstLettersAndRest(displayText, result.n);
          // Match the split used by thumbnailPayload so chrome top and
          // card overflow line up exactly — one cut, two surfaces.
          const split = splitChromeTopAndOverflow(rest, TASKBAR_TITLE_REST_MAX);
          const titleText = split.midWord ? split.title + '…' : split.title;
          try { mainWindow.setTitle(titleText); } catch {}
        }
      } catch {}
    })();
  } else {
    // No hue (shouldn't happen post-assignSessionIdentity, but be safe): default to N=3.
    const { rest } = firstLettersAndRest(displayText);
    const split = splitChromeTopAndOverflow(rest, TASKBAR_TITLE_REST_MAX);
    const titleText = split.midWord ? split.title + '…' : split.title;
    try { mainWindow.setTitle(titleText); } catch {}
  }
}

function onPromptCaptured(promptText) {
  if (typeof promptText !== 'string' || !promptText) return;
  const isFirst = !firstPrompt;
  lastPromptTime = Date.now();

  if (isFirst) assignSessionIdentity();

  if (sessionIndex !== null) {
    sessionsLog.appendEvent(app.getPath('userData'), {
      e: 'prompt', id: sessionIndex, prompt: promptText,
    });
  }

  if (isFirst) {
    firstPrompt = promptText;
    // The boot vocabulary closes here — from now on, arriving OSC titles
    // outside it are logged as the session's drifting title (see the
    // set-title handler).
    // Window title is the "rest" of the identity string — everything past
    // the first N letters that the icon ended up drawing (N is 3 by default,
    // 4 if there was room). Together: [icon: "Mig"] + "rate the database…" =
    // "Migrate the database…", or [icon: "Migr"] + "ate the database…".
    // We render the icon first so we know the chosen N; the title is set
    // from the same N, keeping the icon and title text in sync. Identity
    // starts as the verbatim prompt; if `initialTitle` arrives in the grace
    // window, the set-title handler re-renders both icon and rest from it.
    renderIdentityIconAndTitle();
    syncChromeState();
  }

  // Re-render thumbnail (timeline) with the latest prompts and push fresh
  // bitmaps to DWM. Done for both first and follow-up captures so the
  // taskbar thumbnail body always reflects the current conversation.
  renderAndPushIconicBitmaps();
  refreshTooltip();

  // Stream side: first prompt registers the run with the hub.
  if (streamState) streamState.onPrompt(promptText);
}

function onShellCommandTyped(cmd) {
  // Most recent pre-cliStarted shell command wins. If it matches a known CLI
  // invocation pattern, remember it for the eventual "cli" log entry.
  const cli = detectCli(cmd);
  if (cli) detectedCli = cli;
}

// Take over the identity of an existing session (called when the user picks
// a past session from the picker). Reuses the same id / hue / prompt so the
// session continues in the log as the same record, and the active-file under
// the original id makes other windows show it as currently active.
function resumeFromSession(picked) {
  if (!mainWindow) return;
  iconLocked = true;
  activeFileWritten = true;
  sessionIndex = picked.id;
  lockedHue = (typeof picked.hue === 'number') ? picked.hue : null;
  lockedTitle = picked.title || null;
  initialTitle = picked.initialTitle || null;
  firstPrompt = picked.prompt || null;
  detectedCli = picked.cli || null;
  sessionStartTime = Date.now();
  // No boot vocabulary on resume (firstPrompt is inherited, so collection
  // never opens): banner junk in the title log is instead caught by the
  // brand-label cleaning at display and match time. The CLI re-emits its
  // canonical title shortly after resuming (Claude re-sends the topic
  // title on --resume), so the drifting title recovers on its own.

  const userDataDir = app.getPath('userData');
  // The token is part of the identity a resume inherits: agent-lock's owner
  // record and agent-jobs' events carry it, so the resumed window keeps
  // answering to it. A session recorded before tokens were stored keeps this
  // process's fresh token and records it now, for the next resume.
  if (picked.token) agentSessionId = picked.token;
  else sessionsLog.appendEvent(userDataDir, { e: 'token', id: picked.id, token: agentSessionId });
  try {
    sessionsLog.writeActiveFile(userDataDir, picked.id, {
      pid: process.pid,
      bootTime: sessionsLog.currentBootTime(),
      guiSession: getOwnGuiSession(),
      token: agentSessionId,
      lastInputAt: lastInputTime,
      lastWorkingAt: lastPtyOutputTime,
      lastPromptAt: lastPromptTime,
      hiddenAt: null,
    });
  } catch (err) {
    console.warn('[main] resumeFromSession: writeActiveFile failed:', err && err.message);
  }
  // Same cap machinery as a fresh session.
  enforceVisibleCap();
  startCapControlWatcher();
  startCapTimers();

  // Render + apply icon and thumbnail bitmap in the background. The icon
  // uses identityString() — initialTitle if the original session had one,
  // else firstPrompt — so the resumed window's icon matches what the
  // original session showed. Doesn't block the resume keystroke flow.
  renderIdentityIconAndTitle();
  renderAndPushIconicBitmaps();

  if (promptCapture) {
    promptCapture.notifyCliStarted();
    // Don't lock — keep capturing so follow-up prompts from the resumed
    // session feed the thumbnail timeline. onPromptCaptured branches on
    // whether firstPrompt is already set (it is, from the picked session)
    // and treats new captures as timeline-only entries.
  }
  // Stream side: in the union model, each resume registers a fresh
  // runId → a new tile in the viewer. Stale tiles age out (24h) or get
  // deleted from the viewer's per-card delete button. We don't inherit
  // anything across resumes — keeps the source-side state model trivial
  // and sidesteps every "two sessions overlapping on one runId" bug.
  if (streamState && firstPrompt) streamState.onPrompt(firstPrompt);
  refreshTooltip();
  if (!tooltipInterval) tooltipInterval = setInterval(refreshTooltip, 60_000);
  syncChromeState();
}

function updateProgressBar() {
  if (!mainWindow) return;
  // Only show the bar once a CLI is running, the PTY is actively producing
  // output, AND the user isn't typing (echo would otherwise trigger it on
  // every keystroke). See computeIsWorking() for the full predicate.
  const isWorking = computeIsWorking();
  if (isWorking && !progressBarOn) {
    try { mainWindow.setProgressBar(2, { mode: 'indeterminate' }); } catch {}
    progressBarOn = true;
    // Re-render the thumbnail and chrome bar so both reflect the flip.
    renderAndPushIconicBitmaps();
    syncChromeState();
  } else if (!isWorking && progressBarOn) {
    try { mainWindow.setProgressBar(-1); } catch {}
    progressBarOn = false;
    renderAndPushIconicBitmaps();
    syncChromeState();
  }
}

// Push the current session identity to the renderer's chrome bar (the
// custom titleBarOverlay content). hue / cli / prompt come from the locked
// session state; isWorking is derived from PTY-output recency.
function syncChromeState() {
  if (!mainWindow || !mainWindow.webContents) return;
  const isWorking = computeIsWorking();
  const payload = {
    hue: lockedHue,
    cli: detectedCli || null,
    prompt: firstPrompt || null,
    isWorking,
    lock: lockState,
  };
  try {
    mainWindow.webContents.send('chrome-state', payload);
  } catch {}
}

function pickerSessionPayload(userDataDir, s) {
  let isHidden = false;
  if (s.isActive) {
    const rec = sessionsLog.readActiveFile(userDataDir, s.id);
    isHidden = !!(rec && rec.hiddenAt);
  }
  return {
    id: s.id,
    hue: s.hue,
    cli: s.cli,
    initialTitle: s.initialTitle,
    title: s.title,
    prompt: s.prompt,
    lastEventAt: s.lastEventAt,
    isActive: s.isActive,
    isHidden,
    capturedBranches: s.capturedBranches || [],
  };
}

function showSessionsPicker() {
  if (!mainWindow || !mainWindow.webContents) return;
  // Reflect the picker state in the title bar / button text — until the user
  // chooses something, this is what identifies the window.
  if (!firstPrompt && !detectedCli) {
    try { mainWindow.setTitle('Sessions'); } catch {}
  }
  try {
    const userDataDir = app.getPath('userData');
    const list = sessionsLog.menuList(userDataDir);
    const sessions = list.map(s => pickerSessionPayload(userDataDir, s));
    const activeIds = sessions.filter(s => s.isActive).map(s => s.id);
    mainWindow.webContents.send('show-picker', { sessions, activeIds });
  } catch (err) {
    console.warn('[main] showSessionsPicker failed:', err && err.message);
  }
}

function chromeBarCopyText() {
  return typeof firstPrompt === 'string' ? firstPrompt : '';
}

function copyChromeBarPrompt() {
  const text = chromeBarCopyText();
  if (text) clipboard.writeText(text);
}

// ---- Window-cap helpers ----

// Refresh our active-file timestamps so other windows can score us correctly
// for eviction. Called periodically (throttled to ACTIVITY_REFRESH_MS) and
// on hide/show transitions.
function refreshActivityTimestamps(extra = {}) {
  if (sessionIndex === null || !activeFileWritten) return;
  // No window means there is no live session to advertise to the cap or the
  // picker; keeping the record warm would only make it look reachable.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const userDataDir = app.getPath('userData');
  const beat = {
    // Restamp the boot time. It is a derived value that drifts against the wall
    // clock on Windows, so a stamp frozen at window creation ages out of every
    // other window's tolerance; refreshing keeps all live windows agreeing on
    // the current boot. A process cannot outlive a reboot, so restamping can
    // never certify a record from an earlier boot. Deliberately unlike
    // guiSession, which stays frozen so a ghost cannot re-certify itself.
    bootTime: sessionsLog.currentBootTime(),
    lastInputAt: lastInputTime,
    lastWorkingAt: lastPtyOutputTime,
    lastPromptAt: lastPromptTime,
    hiddenAt: windowHidden ? (extra.hiddenAt || Date.now()) : null,
    ...extra,
  };
  if (sessionsLog.updateActiveFile(userDataDir, sessionIndex, beat)) return;
  // The record is gone while the window is still up — reaped by another
  // process, or lost with the userData directory. Rewrite it whole rather than
  // stay invisible for the rest of this session (updateActiveFile only merges).
  sessionsLog.writeActiveFile(userDataDir, sessionIndex, {
    pid: process.pid,
    guiSession: getOwnGuiSession(),
    token: agentSessionId,
    ...(lockedHue !== null ? { hue: lockedHue } : {}),
    ...beat,
  });
}

function setHidden(hidden) {
  if (!mainWindow) return;
  if (windowHidden === hidden) return;
  windowHidden = hidden;
  try { mainWindow.setSkipTaskbar(hidden); } catch {}
  refreshActivityTimestamps(hidden ? { hiddenAt: Date.now() } : {});
}

// If we're over the visible cap, find the stalest non-working visible
// window (other than us) and ask it to hide. Called on tryLockIcon when a
// new agent-term window has just become an active AI session.
function enforceVisibleCap() {
  if (sessionIndex === null) return;
  const userDataDir = app.getPath('userData');
  const records = windowCap.listLiveRecords(userDataDir);
  if (windowCap.countVisible(records) <= windowCap.MAX_VISIBLE) return;
  const victimId = windowCap.pickEvictionVictim(records, { ignoreId: sessionIndex });
  if (victimId === null) return;        // every visible window is working — leave them alone
  try {
    windowCap.sendControl(userDataDir, victimId, 'hide');
  } catch (err) {
    console.warn('[main] sendControl(hide) failed:', err && err.message);
  }
}

// Auto-close ourselves if we've been hidden + idle for IDLE_CLOSE_MS.
// "Idle" = no user input AND no AI working since we were hidden. Resource
// bound for the Tier-2 hidden cache; the session record stays in the log
// so the user can still resume from the picker.
function checkIdleClose() {
  if (!windowHidden) return;
  const now = Date.now();
  const sinceInput = now - lastInputTime;
  const sinceWorking = now - lastPtyOutputTime;
  if (sinceInput >= windowCap.IDLE_CLOSE_MS && sinceWorking >= windowCap.IDLE_CLOSE_MS) {
    console.log('[main] auto-closing — hidden + idle for', Math.round(sinceInput / 60_000), 'min');
    app.quit();
  }
}

// A compositor-session change means every window on the machine was destroyed.
// Electron does not reliably deliver 'closed' for that (a macOS WindowServer
// crash takes the NSWindow down behind Chromium's back), so this process can
// keep running headless: no window, no dock icon, no way for the user to reach
// it — while its active file still advertises the session. Exit instead. The
// event log keeps the session resumable from the picker.
function checkGuiSessionAlive() {
  const own = getOwnGuiSession();
  if (!own) return;                              // unstamped platform — nothing to compare
  const current = guiSession.currentGuiSession();
  if (!current || current === own) return;       // unknown never reaps
  log('[main] compositor session changed — this window is gone; exiting');
  writeClosedSessionEvent();
  app.quit();
  // The window is already unusable, so a quit that stalls on it must not
  // leave the process (and its PTY) running for the rest of the boot.
  setTimeout(() => app.exit(0), 5000);
}

function startCapTimers() {
  if (!activityRefreshInterval) {
    activityRefreshInterval = setInterval(refreshActivityTimestamps, windowCap.ACTIVITY_REFRESH_MS);
  }
  if (!healthCheckInterval) {
    // Once a minute: ghost check (exit immediately), idle close (at 4h).
    healthCheckInterval = setInterval(() => {
      checkGuiSessionAlive();
      checkIdleClose();
    }, 60 * 1000);
  }
}

function startCapControlWatcher() {
  if (capControlWatcherTeardown || sessionIndex === null) return;
  capControlWatcherTeardown = windowCap.startCapControlWatcher(
    app.getPath('userData'),
    sessionIndex,
    {
      hide: () => setHidden(true),
      show: () => {
        setHidden(false);
        try { if (mainWindow) mainWindow.focus(); } catch {}
      },
      close: () => app.quit(),
    },
  );
}

function shouldAutoRelaunchAfterUserClose() {
  try {
    const userDataDir = app.getPath('userData');
    sessionsLog.gcActiveFiles(userDataDir);
    const records = windowCap.listLiveRecords(userDataDir);
    return windowCap.shouldRelaunchAfterUserClose(records);
  } catch (err) {
    console.warn('[main] relaunch threshold check failed:', err && err.message);
    return true;
  }
}

function relaunchLatestAndExit() {
  if (relaunchStarted) return;
  relaunchStarted = true;
  let target = { mode: 'electron', execPath: null };
  if (app.isPackaged && process.platform === 'win32') {
    try {
      target = resolveLatestRelaunchTarget(process.execPath, {
        version: app.getVersion(),
      });
    } catch (err) {
      // This is an installed versioned build, but its stable latest-version
      // route is broken. Do not knowingly restart the old executable.
      log('[relaunch] refusing old-code fallback: ' + (err && err.message));
      app.exit(1);
      return;
    }
  }
  if (target.execPath) log('[relaunch] routing successor through the stable latest-code launcher');
  try {
    if (target.mode === 'portable-spawn') {
      relaunchPortableAndExit(app, process.argv, target.execPath);
    } else {
      relaunchAndExit(app, process.argv, { execPath: target.execPath });
    }
  } catch (err) {
    log('[relaunch] successor launch failed: ' + (err && err.message));
    app.exit(1);
  }
}

// Cmd/Ctrl+Shift+N: a deliberate extra window. Resolves the same latest-code
// target as the auto-relaunch path, but the current instance keeps running.
// The child is a whole separate Electron process, so nothing paints anywhere
// until it reaches ready-to-show (a couple of seconds, longer on WSL). The
// renderer bridges that gap with a launch pill; every failure path reports
// back so the pill is replaced by an error instead of dying silently.
function launchNewInstance() {
  const announce = (channel, message) => {
    try { if (mainWindow) mainWindow.webContents.send(channel, message); } catch {}
  };
  const fail = (message) => {
    log('[new-instance] ' + message);
    announce('new-instance-launch-failed', message);
  };
  let target = { mode: 'electron', execPath: null };
  if (app.isPackaged && process.platform === 'win32') {
    try {
      target = resolveLatestRelaunchTarget(process.execPath, {
        version: app.getVersion(),
      });
    } catch (err) {
      fail('refusing old-code launch: ' + (err && err.message));
      return;
    }
  }
  announce('new-instance-launching');
  let child = null;
  try {
    child = spawnNewInstance(process.argv, target.execPath || process.execPath, {
      cwd: target.execPath ? path.dirname(target.execPath) : undefined,
    });
  } catch (err) {
    fail('launch failed: ' + (err && err.message));
    return;
  }
  // Boot watch: a spawn can succeed and still die before its window shows (a
  // bad execPath arrives as an async 'error', a boot crash as an early exit).
  // Only an unclean exit inside the watch window is a failure — exit 0 is the
  // user closing the new window right away. Past the window the child is on
  // its own.
  let bootWatchSettled = false;
  let bootWatchTimer = null;
  const settle = (message) => {
    if (bootWatchSettled) return;
    bootWatchSettled = true;
    clearTimeout(bootWatchTimer);
    if (message) fail(message);
  };
  bootWatchTimer = setTimeout(() => settle(null), 15000);
  child.once('error', (err) => settle('launch failed: ' + (err && err.message)));
  child.once('exit', (code, signal) => {
    if (code === 0) { settle(null); return; }
    settle('exited during startup (' + (code === null ? 'signal ' + signal : 'code ' + code) + ')');
  });
}

function writeClosedSessionEvent() {
  if (sessionIndex === null || !activeFileWritten) return;
  const userDataDir = app.getPath('userData');
  try {
    sessionsLog.deleteActiveFile(userDataDir, sessionIndex);
    sessionsLog.appendEvent(userDataDir, { e: 'closed', id: sessionIndex });
  } catch (err) {
    console.warn('[main] failed to write closed event:', err && err.message);
  }
  activeFileWritten = false;
  // Cap-control teardown — fs.watch handle and timers should not survive
  // the session-closed transition.
  if (capControlWatcherTeardown) { try { capControlWatcherTeardown(); } catch {} capControlWatcherTeardown = null; }
  if (activityRefreshInterval) { clearInterval(activityRefreshInterval); activityRefreshInterval = null; }
  if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
}

function getShell() {
  if (process.platform === 'win32') {
    // WSL
    return 'wsl.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

function createWindow() {
  // Custom title-bar: we draw our own session bar (cli + prompt + working
  // dot) into the titleBarOverlay region on Windows. height: 42px fits
  // the terminal's 16px Cascadia Mono with comfortable padding. macOS dev
  // fallback uses default chrome since titleBarOverlay is Windows/Linux only.
  const customTitleBar = process.platform === 'win32' || process.platform === 'linux';
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#0c0c0c',
    titleBarStyle: customTitleBar ? 'hidden' : 'default',
    titleBarOverlay: customTitleBar ? {
      color: '#0c0c0c',
      symbolColor: '#cccccc',
      // 42px gives 16px Cascadia Mono comfortable breathing room and lets
      // the chip render at 32px — readable next to the terminal body
      // below (also 16px Cascadia Mono). Taller than the native ~32px
      // title bar, but the trade-off prioritizes in-window readability
      // over pixel-cloning the OS chrome.
      height: 42,
    } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Lets the renderer host remote pages in a <webview> (the embedded web
      // page viewer for plain-clicked URLs). The guest keeps its own isolated
      // context (contextIsolation on, nodeIntegration off) by default.
      webviewTag: true,
    },
  });

  promptCapture = createPromptCapture({
    onPrompt: onPromptCaptured,
    onShellCommand: onShellCommandTyped,
  });

  // Streaming pipeline: client handles HTTP to the hub asynchronously;
  // stream-state owns the per-session run lifecycle (runId, registration
  // meta). Both instantiated up-front but stay quiet until the first user
  // prompt fires (see onPromptCaptured → streamState.onPrompt).
  streamClient = new StreamClient({
    onStateChange: (status) => {
      try {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('stream:status', status);
        }
      } catch {}
    },
    // Lets the client re-register transparently if the hub returns 404
    // (process restart, eviction). stream-state holds the last RunMeta.
    getRegistration: () => (streamState ? streamState.getRegistration() : null),
    // Same predicate that drives the Windows taskbar progress bar — surfaced
    // on each heartbeat so the viewer's working indicator stays accurate
    // even during quiet stretches when no block is being pushed.
    getIsWorking: () => computeIsWorking(),
    // Inputs drain from heartbeat response; write each to the PTY as
    // plain typed characters followed by a CR. NOT bracketed paste:
    // Claude's "paste-then-CR-outside-paste = submit" is Claude-specific,
    // and Copilot/Codex parse the paste but ignore the trailing CR — the
    // prompt ends up sitting in the input field with no submit. Plain
    // typing + Enter is universal across CLIs.
    //
    // Strip any embedded \r/\n in the prompt — a stray newline anywhere
    // in the body would submit early, breaking the rest. The viewer's
    // single-line input enforces this client-side, but a future or
    // malicious client could POST anything to /input; defense in depth.
    onInputs: (inputs) => {
      if (!ptyProcess) return;
      for (const raw of inputs) {
        if (typeof raw !== 'string' || raw.length === 0) continue;
        // Raw key event (viewer-side ↑/↓/Enter button) — input starts
        // with a control byte (ESC for arrow keys, CR for Enter, etc.).
        // Write verbatim, no auto-CR. Lets the viewer drive interactive
        // TUI navigation (pickers, dialogs) one keypress at a time so
        // the user can see each step and only commit when ready.
        if (raw.charCodeAt(0) < 0x20) {
          let wrote = false;
          try {
            ptyProcess.write(raw);
            wrote = true;
          } catch (err) {
            log('[stream] PTY write failed for raw key: ' + (err && err.message));
          }
          if (wrote && isPlainEnter(raw)) notifyResumeHintSubmit();
          continue;
        }
        // Typed prompt — type as keystrokes + auto-CR via writeAsSubmission.
        const prompt = raw.replace(/[\r\n]+/g, ' ').trim();
        if (!prompt) continue;
        const ok = writeAsSubmission(prompt);
        if (ok) notifyResumeHintSubmit();
        if (!ok) log('[stream] PTY write failed for remote input');
      }
    },
    // Voice-origin transcripts (hub /voice — voice.md in agent-stream-hub).
    // Prefixed with a reference to the vendored guide so the agent knows
    // the text is raw speech-to-text and repairs it against session
    // context before acting. The transcript starts on its own line —
    // agent-term's convention for injected prompts — delivered via
    // bracketed paste (like the review-comment path) so the embedded
    // newline doesn't submit early. The prefix string is a published
    // contract (voice-to-agent/.maintainer/guide-design.md) — change it
    // there first.
    onVoiceInputs: (transcripts) => {
      if (!ptyProcess) return;
      for (const raw of transcripts) {
        if (typeof raw !== 'string') continue;
        const transcript = raw.replace(/[\r\n]+/g, ' ').trim();
        if (!transcript) continue;
        const ok = writeAsBracketedPasteSubmission(
          '[@voice-to-agent/interpret.md]\n' +
          transcript
        );
        if (ok) notifyResumeHintSubmit();
        if (!ok) log('[stream] PTY write failed for voice input');
      }
    },
  });
  streamState = new StreamState({
    client: streamClient,
    getCli: () => detectedCli || null,
    getIsWorking: () => computeIsWorking(),
    getHue: () => (typeof lockedHue === 'number' ? lockedHue : null),
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.maximize();

  // The renderer attaches its stream-status listener during page load,
  // after the constructor's initial _setState (e.g., 'disabled' when
  // hubUrl is missing) has already fired and been dropped. Re-push the
  // current snapshot here so the hollow-grey "disabled" dot is visible
  // for misconfigured machines instead of leaving them looking dead.
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      if (streamClient && mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('stream:status', streamClient.getStatus());
      }
    } catch {}
  });

  // index.html IS the app: the shell never navigates and never opens a window of
  // its own. So anything that tries is a link — an md-viewer link, a stray anchor,
  // a dropped file — and left alone it would replace the terminal with that page,
  // session and all, with no back button to return. http(s) goes to the browser
  // (same destination as the md viewer's own link clicks); anything else is dropped
  // with a log. Neither hook fires for the app's own loadFile, which is programmatic.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url, 'app window popup');
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (navEvent, targetUrl) => {
    navEvent.preventDefault();
    openInSystemBrowser(targetUrl, 'app window navigation');
  });

  // Intercept caret shortcuts here and send IPC to the renderer to trigger the action directly.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (shouldShowCaretDiagnosticsShortcut(input, process.platform)) {
      event.preventDefault();
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('show-caret-diagnostics');
      }
      return;
    }

    if (shouldInsertCaretPositionShortcut(input, process.platform)) {
      event.preventDefault();
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('insert-caret-position');
      }
      return;
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    showSessionsPicker();
  });

  // DevTools accelerators. Cmd/Ctrl+Shift+I shrinks the viewer band, so DevTools
  // stays on F12 everywhere and on the native Cmd+Opt+I chord on macOS.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    const cmdOptI = input.meta && input.alt && (k === 'I' || k === 'i');
    if (k === 'F12' || cmdOptI) {
      event.preventDefault();
      try { mainWindow.webContents.toggleDevTools(); } catch {}
      return;
    }
    // Cmd/Ctrl+Shift+U opens the filterable selector over every viewer candidate
    // (the renderer merges scrollback and live extraction); ...+O toggles the
    // band shown/hidden, ...+I toggles its open size golden⇄full.
    const viewerAction = getViewerShortcutAction(input, process.platform);
    if (viewerAction) {
      event.preventDefault();
      try { mainWindow.webContents.send('viewer-shortcut', viewerAction); } catch {}
      return;
    }
    // Cmd/Ctrl+Shift+N: launch a fresh AgentTerm instance alongside this one.
    // It opens on the sessions picker + launcher, like any fresh start.
    const cmdShiftN = (input.control || input.meta) && input.shift && (k === 'N' || k === 'n');
    if (cmdShiftN) {
      event.preventDefault();
      launchNewInstance();
      return;
    }
    // Cmd/Ctrl+Shift+R (dev only): relaunch in place to pick up every edited
    // runtime source without a manual close + `npm run start`. The successor
    // rebuilds all generated bundles before it creates a window; a broken build
    // aborts instead of running any artifact from the previous process.
    const cmdShiftR = (input.control || input.meta) && input.shift && (k === 'R' || k === 'r');
    if (cmdShiftR && !app.isPackaged) {
      event.preventDefault();
      log('[dev] manual relaunch (Cmd/Ctrl+Shift+R)');
      relaunchLatestAndExit();
    }
  });

  // Iconic-thumbnail focus suppression: while the window is focused we defer
  // renderAndPushIconicBitmaps (pendingRender = true). When the user alt-tabs
  // away the blur event fires this one push — bringing the iconic cache up
  // to date right before they're likely to glance at the taskbar.
  mainWindow.on('blur', () => {
    if (pendingRender) {
      renderAndPushIconicBitmaps();
    }
  });

  mainWindow.on('closed', () => {
    // Unhook our window-message subscriptions before the HWND is destroyed.
    if (iconicHooksInstalled && mainWindow && typeof mainWindow.unhookWindowMessage === 'function') {
      try { mainWindow.unhookWindowMessage(WM_DWMSENDICONICTHUMBNAIL); } catch {}
      try { mainWindow.unhookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP); } catch {}
    }
    iconicHooksInstalled = false;
    // Free the GDI HBITMAPs we own before the HWND is destroyed.
    if (cachedThumbHBitmap) { dwm.deleteHBitmap(cachedThumbHBitmap); cachedThumbHBitmap = null; }
    if (cachedLiveHBitmap)  { dwm.deleteHBitmap(cachedLiveHBitmap);  cachedLiveHBitmap  = null; }
    cachedThumbSize = null;
    cachedLiveSize  = null;
    cachedHwnd = null;
    mainWindow = null;
    if (tooltipInterval) {
      clearInterval(tooltipInterval);
      tooltipInterval = null;
    }
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    // Graceful close (X button): record session end before tearing down PTY.
    writeClosedSessionEvent();
    if (ptyProcess) {
      userClosed = true;
      try { ptyProcess.kill(); }
      catch (err) { log('[main] PTY kill during close failed: ' + (err && err.message)); }
    }
  });

  let resizeTimer = null;
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (mainWindow && ptyProcess) {
        const [width, height] = mainWindow.getContentSize();
        mainWindow.webContents.send('resize', { width, height });
      }
    }, 150);
  });

  // Re-render iconic bitmaps whenever the window size or position changes.
  // The live-preview bitmap is sized to match the window's physical pixels,
  // so a stale cache after resize results in DWM displaying our small old
  // bitmap 1:1 in the top-left corner of a larger Aero Peek area (the
  // "1/4 size top-left" symptom). 'move' is also wired because moving the
  // window to a different monitor can change the display scale factor.
  // Force-bypass the payload-hash cache (the payload didn't change, just
  // the window dimensions) by nulling lastPushedPayloadHash before firing.
  let iconicResizeTimer = null;
  function scheduleIconicReRender() {
    if (iconicResizeTimer) clearTimeout(iconicResizeTimer);
    iconicResizeTimer = setTimeout(() => {
      iconicResizeTimer = null;
      lastPushedPayloadHash = null;
      renderAndPushIconicBitmaps();
    }, 250);
  }
  mainWindow.on('resize',  scheduleIconicReRender);
  mainWindow.on('move',    scheduleIconicReRender);
  // 'resize' doesn't reliably fire on un-minimize when the window
  // restores to the same dimensions it had before. Without an explicit
  // 'restore' handler the live-preview cache would stay stale (or stay
  // skipped, if the last attempt happened while minimized).
  mainWindow.on('restore', scheduleIconicReRender);
}

let wslPidFile = null;

function ptyStartingCwd() {
  // A source launch explicitly carries npm's invocation directory. On Windows
  // this option belongs to the Win32 wsl.exe process while wslShellArgs passes
  // the POSIX workspace through --cd; native PTYs use the workspace directly.
  if (!app.isPackaged) {
    if (process.platform === 'win32') return process.cwd();
    return requireSourceStartCwd();
  }
  // Packaged GUI launches have no npm invocation directory.
  return process.env.HOME || os.homedir();
}

function createPty(cols, rows) {
  const shell = getShell();

  ptyProcess = pty.spawn(shell, process.platform === 'win32' ? wslShellArgs() : [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: ptyStartingCwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      // Own terminal identity. Without it the shell inherits the launching
      // terminal's TERM_PROGRAM (e.g. Apple_Terminal) and runs that
      // terminal's shell hooks — Apple's zshrc emits OSC 7 cwd reports meant
      // for Terminal.app on every prompt.
      TERM_PROGRAM: 'AgentTerm',
      TERM_PROGRAM_VERSION: app.getVersion(),
      // Session identity for the background-job contract (job-events.md) and
      // for agent-lock's owner record: ordinary env inheritance scopes it to
      // this window's process tree.
      AGENT_SESSION_ID: agentSessionId,
      // Windows env does not cross into WSL by default; WSLENV lists the
      // variables that do.
      ...(process.platform === 'win32'
        ? {
          WSLENV: [process.env.WSLENV, 'AGENT_SESSION_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']
            .filter(Boolean).join(':'),
        }
        : {}),
    },
  });

  if (process.platform === 'win32') {
    wslPidFile = `/tmp/.agent-term-pid-${process.pid}`;
    ptyProcess.write(`echo $$ > ${wslPidFile}\n`);
  }

  ptyStartedAt = Date.now();
  startLockWatch(); // poll the repo for agent-lock's lock/agent → padlock in the chrome bar
  startJobWatch(); // nudge the agent when a background job ends while it idles

  // Runs on node-pty's threadsafe-function callback. An exception thrown here
  // cannot be delivered as a JS exception once the environment is unwinding, so
  // N-API rethrows it as C++ and the process aborts — a quit reported as
  // "Electron quit unexpectedly" rather than an exit. The window is torn down
  // before the shell is, and webContents.send on a destroyed target throws, so
  // this path is reachable on any quit while the CLI is still printing.
  ptyProcess.onData((data) => {
   try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('pty-output', data);
    }
    // Track recent output time for the "AI working" progress bar indicator
    // and for window-cap eviction scoring (lastWorkingAt in the active-file).
    // lastAgentOutputTime is deliberately NOT bumped here: raw bytes can't
    // tell content from status churn — the screen watcher's classified
    // pushes feed it instead (see the stream:buffer-update handler).
    lastPtyOutputTime = Date.now();
    // Auto-show: if we're hidden and the AI is producing output (something
    // worth attention happened), pop ourselves back into the taskbar so the
    // user can see/find us. Don't steal focus — they may be in another
    // window working on something else.
    if (windowHidden) setHidden(false);
   } catch (err) {
    try { log('[main] pty data handler failed: ' + (err && err.message)); } catch {}
   }
  });

  // "AI working" indicator — Windows taskbar progress bar in indeterminate
  // mode draws an animated bar under the icon while the CLI is producing
  // output, clears when it goes quiet. Only enabled after the icon has been
  // locked (= AI CLI booted), so the bar doesn't fire for shell-only windows.
  if (!progressInterval) {
    progressInterval = setInterval(updateProgressBar, PROGRESS_POLL_MS);
  }

  // Same threadsafe-function rule as onData above: nothing may escape.
  ptyProcess.onExit(({ exitCode }) => {
   try {
    ptyProcess = null;
    // Seal the open block + stop heartbeating. The run stays in the hub
    // so the viewer can still browse it; the heartbeat dot will mark it
    // as stale.
    try { if (streamClient) streamClient.stop(); } catch {}
    // Graceful close (`exit` typed in shell): record session end. App will
    // not auto-relaunch because userClosed is still false on this path.
    // Idempotent, so the window-close path having already written it is fine.
    writeClosedSessionEvent();
    app.quit();
   } catch (err) {
    try { log('[main] pty exit handler failed: ' + (err && err.message)); } catch {}
   }
  });
}

// Plain Enter keystroke (single \r or \n) — used by the resume intercept.
// Anything else (chars, control sequences with content) is NOT a plain Enter.
function isPlainEnter(data) {
  if (typeof data !== 'string') return false;
  return data === '\r' || data === '\n' || data === '\r\n';
}

// Stream pipeline IPC — renderer pushes buffer state to main, which
// forwards to stream-state (see src/stream/renderer-watch.js). The same
// pushes feed the job-watch "agent active" clock: the watcher classifies
// each change (payload.substantial), so status-churn repaints don't count
// — see lastAgentOutputTime.
function noteAgentScreenActivity() {
  const now = Date.now();
  if (now - lastTypingTime > USER_QUIET_MS) lastAgentOutputTime = now;
}
ipcMain.on('stream:buffer-update', (event, payload) => {
  try {
    if (payload && payload.substantial) noteAgentScreenActivity();
    if (streamState) streamState.onBufferUpdate(payload);
  } catch {}
});
ipcMain.on('stream:buffer-flip', (event, payload) => {
  try {
    // An alt-screen enter/exit is real activity by definition.
    noteAgentScreenActivity();
    if (streamState) streamState.onBufferFlip(payload);
  } catch {}
});

// IPC handlers
ipcMain.on('pty-input', (event, data) => {
  // Some pty-input events are auto-generated by xterm.js / the renderer
  // (terminal protocol), not real user keystrokes. On macOS (real PTY,
  // not WSL/ConPTY), the AI CLI commonly probes the terminal at startup —
  // cursor-position (ESC[6n → ESC[r;cR), primary device attributes
  // (ESC[c → ESC[?1;2c), palette queries (ESC]4;n;?), etc. — and xterm.js
  // emits the replies through the same channel as user input.
  //
  // Treating these as user input has two bad consequences:
  //   1. The resume intercept disarms before the user gets a chance to
  //      press Enter (legacy concern).
  //   2. The resume auto-fire state machine sees its lastInputTime jump
  //      past resumeArmedAt and cancels itself — so auto-fire never
  //      fires for any CLI that does terminal queries on startup
  //      (which is basically all of them).
  // Both must be gated on this flag.
  //
  // Rule: any multi-byte ESC-prefixed control sequence is treated as
  // protocol, never as user input. Bare ESC (the Esc key) still counts
  // as user input — that's a real "get out of my way" signal.
  const isAutoTerminalProtocol = (
    typeof data === 'string' &&
    data.length > 1 &&
    data.charCodeAt(0) === 0x1b &&
    /^\x1b[\[\]OP_^]/.test(data)
  );

  // Resume intercept: if a past session was just picked, replace the user's
  // first plain Enter with the /resume submission so the CLI opens its
  // resume search dialog. Any non-Enter input cancels the intercept (user
  // is typing their own command — we get out of their way). The visual
  // resume-hint overlay tells them what to filter for either way.
  if (pendingResumeIntercept && ptyProcess) {
    if (isPlainEnter(data)) {
      const wrote = writeAsSubmission('/resume');
      log('[resume] intercept fired wrote=' + wrote);
      if (wrote) notifyResumeHintSubmit();
      pendingResumeIntercept = false;
      lastInputTime = Date.now();
      // /resume is a submit too — release the progress-bar typing
      // suppression so the indicator can fire as the resume search runs.
      lastTypingTime = 0;
      lastInputByte = '';
      return;  // swallow the original Enter; writeAsSubmission sends its own CR
    }
    if (!isAutoTerminalProtocol) {
      log('[resume] intercept cancelled by non-Enter input: ' +
          JSON.stringify(typeof data === 'string' ? data.slice(0, 16) : data));
      pendingResumeIntercept = false;
    }
  }
  if (ptyProcess) {
    ptyProcess.write(data);
  }
  const now = Date.now();
  // Window-cap activity tracking: only REAL keystrokes count. Auto-
  // protocol responses don't — they're the CLI talking to the terminal,
  // not the user touching the keyboard.
  // Progress-bar typing tracker + compose-hold signal: bumps on composing
  // input, RESETS on a submit-Enter (plain `\r`/`\n` not preceded by `\`).
  // Backslash-Enter is treated as a newline (still composing) — many AI
  // CLIs use `\<Enter>` for in-buffer line breaks. Guarded like
  // lastInputTime: protocol traffic (focus in/out on every window switch,
  // DSR replies) is not typing — unguarded it kept userComposing() latched
  // whenever the user was merely around, holding host notices forever.
  if (!isAutoTerminalProtocol) {
    lastInputTime = now;
    const isEnterByte = (data === '\r' || data === '\n' || data === '\r\n');
    const isBackslashEnter = isEnterByte && lastInputByte === '\\';
    // Ctrl+C / Ctrl+U end a composition without submitting one: the line is
    // gone, so the compose hold must not outlive it. This is what lets the
    // hold be a state rather than a timer (see userComposing).
    const clearsLine = (data === '\x03' || data === '\x15');
    if (isEnterByte && !isBackslashEnter) {
      lastTypingTime = 0;
      if (ptyProcess) notifyResumeHintSubmit();
    } else if (clearsLine) {
      lastTypingTime = 0;
    } else {
      lastTypingTime = now;
    }
  }
  // Remember the last byte of this event so the next event's Enter check
  // knows whether `\` immediately preceded it. Pastes / multi-char chunks
  // leave their trailing byte here.
  if (typeof data === 'string' && data.length > 0) {
    lastInputByte = data[data.length - 1];
  }
  // Feed user keystrokes/pastes through the prompt-capture state machine. The
  // capture is a no-op once it has locked on the first prompt (or before
  // cliStarted, which flips when the AI CLI sets its first OSC title).
  if (promptCapture && !promptCapture.isLocked()) {
    promptCapture.handleInput(typeof data === 'string' ? data : String(data));
  }
});

ipcMain.handle('submit-inline-comment', async (event, body, { toPrompt = false } = {}) => {
  const text = normalizeInlineCommentSubmission(body);
  if (!text) return { success: false, error: 'Empty comment' };

  const ok = pasteAgentPing(text, { toPrompt });
  if (!ok) return { success: false, error: 'No active terminal process' };
  return { success: true };
});

ipcMain.on('pty-resize', (event, { cols, rows }) => {
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

ipcMain.on('pty-start', (event, { cols, rows }) => {
  createPty(cols, rows);
});

ipcMain.on('set-title', (event, title) => {
  if (!mainWindow) return;
  // Title bar rule (in priority order):
  //   1) firstPrompt set: identity drives the visible title (icon + rest),
  //      not the live OSC title — but we still record it
  //   2) detectedCli set but no prompt: show "<cli> — waiting for prompt"
  //   3) shell/no CLI: pass through whatever the CLI/shell pushed
  // darwin: rules 1-2 don't apply — the title is composed from CLI + live
  // task title by syncMacWindowTitle() at the end, after recording.
  if (firstPrompt) {
    // already on identity — record below but don't override
  } else if (detectedCli) {
    if (process.platform !== 'darwin') {
      mainWindow.setTitle(`${detectedCli} — waiting for prompt`);
    }
  } else {
    mainWindow.setTitle(title);
  }
  tryLockIcon(title);
  // Collect the boot vocabulary: every title key seen before the first
  // prompt. Brand banners and their spinner-frame variants land here and
  // are filtered from the title event log below.
  const titleEventKey = aiTitleDedupeKey(title, detectedCli);
  if (firstPrompt === null && titleEventKey) bootTitleKeys.add(titleEventKey);
  // After the initial lock, AI CLIs push updated titles as the user works.
  // Record them as `lockedTitle` and as title events — the picker shows the
  // latest, which converges on the CLI's own canonical session title (the
  // string its resume selector shows: Claude's AI topic title, Cursor's
  // task title). Deliberately unfrozen and undeadlined: the verbatim first
  // prompt is the intentional frozen identity, while a CLI-distilled title
  // may only exist once the model generates it — Claude's lands well after
  // the first response starts, Cursor's within seconds. Both get captured.
  if (iconLocked && isUsableTitle(title) && title !== lockedTitle) {
    lockedTitle = title;
    syncChromeState();
    // Log gating: spinner-frame churn ("✳ Fix bug" → "✻ Fix bug") changes
    // the raw title every tick — append only when the semantic key moves,
    // and never for keys the CLI already used before it saw a prompt.
    const logworthy = titleEventKey
      && titleEventKey !== lastTitleEventKey
      && !bootTitleKeys.has(titleEventKey);
    if (sessionIndex !== null && activeFileWritten && logworthy) {
      lastTitleEventKey = titleEventKey;
      try {
        sessionsLog.appendEvent(app.getPath('userData'), {
          e: 'title', id: sessionIndex, title: lockedTitle,
        });
      } catch {}
      // A semantic title change lands in the thumbnail card's timeline —
      // re-render so it shows without waiting for the next prompt event.
      renderAndPushIconicBitmaps();
    }
    refreshTooltip();
  }
  // darwin: recompose after the recording above so the title tracks the
  // latest usable OSC title; junk pushes leave the previous subject up.
  syncMacWindowTitle();
});

// ---- Sessions picker IPC ----

function sendHiddenSearchProgress(sender, payload) {
  try {
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return false;
    sender.send('hidden-search-progress', payload);
    return true;
  } catch {
    return false;
  }
}

function cancelHiddenPromptSearch(requestId) {
  if (!requestId) return;
  const search = hiddenPromptSearches.get(requestId);
  if (search) search.cancelled = true;
}

function groupPromptEventsBySession(userDataDir, wantedIds) {
  const eventsById = new Map();
  for (const ev of sessionsLog.readLog(userDataDir)) {
    if (ev.e !== 'prompt') continue;
    if (typeof ev.id !== 'number') continue;
    if (!wantedIds.has(ev.id)) continue;
    if (!eventsById.has(ev.id)) eventsById.set(ev.id, []);
    eventsById.get(ev.id).push(ev);
  }
  return eventsById;
}

function nextTick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function runHiddenPromptSearch(sender, requestId, query, search) {
  const term = String(query || '').trim();
  let matchCount = 0;
  try {
    if (term.length < 3) {
      sendHiddenSearchProgress(sender, { requestId, query: term, done: true, matchCount: 0, sessions: [] });
      return;
    }
    const userDataDir = app.getPath('userData');
    const sessions = sessionsLog.menuList(userDataDir);
    const wantedIds = new Set(sessions.map(s => s.id));
    const eventsById = groupPromptEventsBySession(userDataDir, wantedIds);

    for (const s of sessions) {
      if (search.cancelled) return;
      const group = sessionsLog.searchHiddenPromptMatchesForSession(
        s,
        eventsById.get(s.id) || [],
        term,
        { minChars: 3 },
      );
      if (group) {
        matchCount += group.matchCount;
        const ok = sendHiddenSearchProgress(sender, {
          requestId,
          query: term,
          done: false,
          matchCount,
          sessions: [{
            ...pickerSessionPayload(userDataDir, s),
            hiddenMatchCount: group.matchCount,
            hiddenMatches: group.matches,
          }],
        });
        if (!ok) {
          search.cancelled = true;
          return;
        }
      }
      await nextTick();
    }

    if (!search.cancelled) {
      sendHiddenSearchProgress(sender, {
        requestId,
        query: term,
        done: true,
        matchCount,
        sessions: [],
      });
    }
  } catch (err) {
    console.warn('[main] search-hidden-prompts failed:', err && err.message);
    if (!search.cancelled) {
      sendHiddenSearchProgress(sender, {
        requestId,
        query: term,
        done: true,
        matchCount,
        sessions: [],
      });
    }
  } finally {
    if (hiddenPromptSearches.get(requestId) === search) {
      hiddenPromptSearches.delete(requestId);
    }
  }
}

ipcMain.on('hidden-search-start', (event, payload = {}) => {
  const requestId = String(payload.requestId || '');
  if (!requestId) return;
  cancelHiddenPromptSearch(requestId);
  const search = { cancelled: false };
  hiddenPromptSearches.set(requestId, search);
  runHiddenPromptSearch(event.sender, requestId, payload.query, search);
});

ipcMain.on('hidden-search-cancel', (event, payload = {}) => {
  cancelHiddenPromptSearch(String(payload.requestId || ''));
});

ipcMain.on('picker-pick', (event, id) => {
  const userDataDir = app.getPath('userData');
  const sessions = sessionsLog.listSessions(userDataDir);
  const picked = sessions.find(s => s.id === id);
  if (!picked || !picked.cli) return;
  // Inherit the picked session's identity (id, hue, prompt, active-file) so
  // this window IS that session, not a new one. Other windows then see it
  // as currently active.
  resumeFromSession(picked);
  // Spawn the CLI command (e.g. `claude\r`) and arm the resume intercept.
  // The intercept replaces the user's first plain Enter with a timed
  // /resume submission — see the pty-input handler. User-as-timing-
  // signal is reliable in a way that no programmatic "CLI ready" signal is.
  if (ptyProcess) {
    // The shell was spawned with this process's fresh token; a stored one
    // reaches the resumed CLI (and every tool shell under it) through its
    // environment instead. `env` works in every shell the pty may run.
    const launch = picked.token ? `env AGENT_SESSION_ID=${agentSessionId} ${picked.cli}` : picked.cli;
    // Relaunch from the directory the session was recorded in. The stored
    // path is in this shell's own terms (captured via getPrimaryCwd on the
    // same platform), so a plain cd replays it on macOS and WSL alike. &&
    // keeps the failure loud: if the directory is gone the CLI doesn't
    // launch somewhere wrong — the shell prints the cd error instead.
    const command = picked.cwd ? `cd ${shellEscape(picked.cwd)} && ${launch}` : launch;
    try { ptyProcess.write(command + '\r'); } catch {}
    pendingResumeIntercept = true;
    log('[resume] armed intercept after picker-pick id=' + id +
        ' cli=' + picked.cli);
  }
});

ipcMain.on('picker-start-new', (event, cli) => {
  // cli may be a known CLI name, an arbitrary command literal, or null/empty.
  // No resume intercept on fresh starts — only on resumes from past sessions.
  pendingResumeIntercept = false;
  if (!cli || !ptyProcess) return;
  // Only set detectedCli if cli matches a known AI CLI. Arbitrary command
  // literals (typed by user) launch and run, but don't trigger session
  // recording — they're treated as ordinary shell commands.
  const known = detectCli(cli);
  if (known) {
    detectedCli = known;
    // Show the banner immediately in "(starting…)" state; tryLockIcon will
    // upgrade it once the OSC title arrives.
    syncChromeState();
    // Title bar reflects the waiting-for-prompt state so the taskbar button
    // doesn't briefly flash whatever the CLI sets first. darwin: the chrome
    // band shows the waiting state, so the title is the CLI name alone.
    try {
      mainWindow.setTitle(process.platform === 'darwin'
        ? known
        : `${known} — waiting for prompt`);
    } catch {}
  }
  try { ptyProcess.write(cli + '\r'); } catch {}
});

ipcMain.on('picker-close', () => {
  // Nothing to do — picker dismissed, user gets a fresh shell.
});

// Right-click on the chrome bar copies the full captured prompt.
ipcMain.on('chrome-bar-contextmenu', () => {
  copyChromeBarPrompt();
});

// User dismissed the resume-hint (clicked ✕) before pressing Enter. Drop
// the intercept so their next Enter goes through to the CLI as a normal
// keystroke instead of being swallowed into a /resume.
ipcMain.on('cancel-resume-intercept', () => {
  pendingResumeIntercept = false;
});

// Picker → bring a hidden active session back to the taskbar. Sends a
// 'show' control file addressed to the target window; the target's
// cap-control watcher flips setSkipTaskbar(false) and focuses itself.
ipcMain.on('picker-bring-forward', (event, id) => {
  if (typeof id !== 'number') return;
  try {
    windowCap.sendControl(app.getPath('userData'), id, 'show');
  } catch (err) {
    console.warn('[main] picker-bring-forward failed:', err && err.message);
  }
});

// Save clipboard image to temp file, return path (WSL-converted on Windows)
ipcMain.handle('save-clipboard-image', () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const png = image.toPNG();
  const filename = `clipboard-${Date.now()}.png`;
  const filePath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(filePath, png);
  if (process.platform === 'win32') {
    // Convert C:\Users\...\file.png → /mnt/c/Users/.../file.png
    return filePath
      .replace(/^([A-Z]):\\/i, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
      .replace(/\\/g, '/');
  }
  return filePath;
});

// Generic helper to send navigation requests to PyCharm plugin via TCP
async function sendNavigationRequest(request, port = NAVIGATOR_PORT) {
  const pluginLabel = port === FRONTEND_PORT
    ? 'PyCharm navigator frontend plugin (port 8766)'
    : 'PyCharm navigator plugin (port 8765)';
  return new Promise((resolve) => {
    const client = new net.Socket();
    let responseData = '';

    client.setTimeout(5000);

    client.on('connect', () => {
      log('[navigate] Connected to', pluginLabel);
      const requestStr = JSON.stringify(request);
      log('[navigate] Sending:', requestStr);
      client.write(requestStr + '\n');
    });

    client.on('data', (data) => {
      responseData += data.toString();
      log('[navigate] Received data:', responseData);
      if (responseData.includes('\n')) {
        try {
          const response = JSON.parse(responseData.trim());
          log('[navigate] Parsed response:', response);
          client.destroy();
          resolve({ success: true, ...response });
        } catch (e) {
          log('[navigate] Parse error:', e.message);
          client.destroy();
          resolve({ success: false, error: 'Invalid response from navigator' });
        }
      }
    });

    client.on('timeout', () => {
      log('[navigate] Connection timeout');
      client.destroy();
      resolve({ success: false, error: `Connection timeout - is ${pluginLabel} running?` });
    });

    client.on('error', (err) => {
      log('[navigate] Connection error:', err.code, err.message);
      client.destroy();
      if (err.code === 'ECONNREFUSED') {
        resolve({ success: false, error: `Cannot connect to ${pluginLabel}` });
      } else {
        resolve({ success: false, error: `Connection error: ${err.message}` });
      }
    });

    client.connect(port, NAVIGATOR_HOST);
  });
}

// Navigate to file:line in PyCharm via the navigator plugin
ipcMain.handle('navigate-to-file', async (event, { filePath, line, column, matchText }) => {
  log('[navigate] Received file request:', filePath, line, column);
  return navigateToFile({
    filePath,
    line,
    column,
    matchText,
    sendNavigationRequest,
    frontendPort: FRONTEND_PORT,
  });
});

// Navigate to symbol in PyCharm via the navigator plugin
ipcMain.handle('navigate-to-symbol', async (event, { symbolName, fileHint }) => {
  log('[navigate] Received symbol request:', symbolName, fileHint ? `(hint: ${fileHint})` : '');
  return navigateToSymbol({
    symbolName,
    fileHint,
    sendNavigationRequest,
    frontendPort: FRONTEND_PORT,
  });
});

// Get current caret position (file + line) from the frontend plugin on the IDE client
ipcMain.handle('get-caret-position', async () => {
  log('[navigate] Received caret request');
  return getCaretPosition({
    sendNavigationRequest,
    frontendPort: FRONTEND_PORT,
    backendPort: NAVIGATOR_PORT,
  });
});

ipcMain.handle('get-caret-diagnostics', async () => {
  log('[navigate] Received caret diagnostics request');
  return getCaretDiagnostics({ sendNavigationRequest, frontendPort: FRONTEND_PORT });
});

ipcMain.handle('open-url', async (event, url) => {
  if (/^(?:https?|file):\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

// Hand a link to the real browser. The one exit the app offers a link it won't
// render itself — so it stays http(s) only: any other scheme would be asking the
// OS to launch a handler on a URL that came from a remote page, and is dropped
// with a log instead.
function openInSystemBrowser(rawUrl, source) {
  if (!/^https?:\/\//i.test(rawUrl || '')) {
    log(`[links] ${source}: dropped non-http url ${rawUrl}`);
    return;
  }
  log(`[links] ${source} → system browser: ${rawUrl}`);
  shell.openExternal(rawUrl).catch((e) => log(`[links] openExternal failed: ${e && e.message}`));
}

// --- Resource file helpers (WSL path resolution) ---

function wslExecRaw(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('wsl', wslCommandArgs(args), {
      timeout: options.timeout || 3000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function wslExec(args) {
  const stdout = await wslExecRaw(args);
  return stdout.trim();
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function getWSLCwd() {
  if (!wslPidFile) return null;
  try {
    const pid = await wslExec(['cat', wslPidFile]);
    if (!pid) return null;
    return await wslExec(['readlink', `/proc/${pid}/cwd`]);
  } catch {
    return null;
  }
}

// --- Clicked-path resolution (shared POSIX seam) ---
// One resolver for every clicked terminal path, on both platforms: the files
// live in WSL on Windows (where the UI process's own fs can't reach them) and
// locally on macOS, so all probing goes through posixSh. Returns
//   { path }              unique hit (absolute POSIX path)
//   { choices: [...] }    a relative-path search matched several files
//   null                  nothing found
// Resolution order: absolute / ~ verified as-is → exact under the live shell
// cwd → search under the cwd → search across $HOME. The home sweep makes paths
// printed by other repos/sessions clickable. A clicked path with slashes must
// match as a whole suffix (-path '*/src/foo.js'); a bare filename matches by
// -name. Bulky trees are pruned so the sweep returns within its timeout, and a
// timed-out find still yields the hits it printed before the kill.
// .git is pruned by content, not by name: discussion docs live at
// .git/discussion/<topic>.md by convention and must stay clickable, while the
// rest of .git (objects, refs, the review runtime) stays out of every search.
const CLICK_SEARCH_PRUNE = String.raw`\( -name node_modules -o -name .cache -o -name .npm -o -name Library -o \( -path '*/.git/*' ! -path '*/.git/discussion' ! -path '*/.git/discussion/*' \) \) -prune -o`;
const CLICK_SEARCH_MAX_CHOICES = 8;
// The markdown chooser filters as you type, so it can present a longer list of
// same-named files than the fixed Alt-click chooser (where 8 is all that fits).
const MARKDOWN_CHOICE_MAX = 200;
// Bare-name duplicate sweep (resolveMarkdownChoices): repo tree first and in
// full, then siblings until this many seconds elapse. Python because the walk
// must stop on a deadline, not on pipe backpressure; python3 is already a seam
// dependency (the stat probe).
const MARKDOWN_SIBLING_BUDGET_S = 3;
const MARKDOWN_SWEEP_PY = `
import os, sys, time
cwd, root, name = sys.argv[1], sys.argv[2], sys.argv[3]
budget, cap = float(sys.argv[4]), int(sys.argv[5])
prune = {"node_modules", ".cache", ".npm", "Library"}
hits = []
def sweep(top, skip, deadline):
    for dirpath, dirnames, filenames in os.walk(top):
        if deadline is not None and time.monotonic() > deadline:
            return
        if skip is not None and os.path.normpath(dirpath) == skip:
            dirnames[:] = []
            continue
        if os.path.basename(dirpath) == ".git":
            dirnames[:] = [d for d in dirnames if d == "discussion"]
            continue
        dirnames[:] = [d for d in dirnames if d not in prune]
        if name in filenames:
            hits.append(os.path.join(dirpath, name))
            if len(hits) >= cap:
                return
sweep(cwd, None, None)
if os.path.normpath(root) != os.path.normpath(cwd) and len(hits) < cap:
    sweep(root, os.path.normpath(cwd), time.monotonic() + budget)
sys.stdout.write("\\n".join(hits))
`;

async function searchClickedPath(root, rel, timeout) {
  const pattern = rel.includes('/')
    ? `-path ${shellEscape('*/' + rel)}`
    : `-name ${shellEscape(rel)}`;
  // `| head` instead of -quit: -quit is GNU-only, and head also caps the
  // multi-hit case (anything beyond the choice list is unpresentable anyway).
  const r = await posixSh(
    `find ${shellEscape(root)} ${CLICK_SEARCH_PRUNE} ${pattern} -print 2>/dev/null | head -${CLICK_SEARCH_MAX_CHOICES}`,
    { timeout });
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// search: 'fallback' (default) opens the nearest interpretation fast — an
// exact hit under the shell cwd wins outright and the wider searches only run
// when it misses. 'always' (Alt-click) runs the full sweep even when the cwd
// hit exists, so every candidate lands in the chooser (cwd hit listed first).
async function resolveClickedPath(filePath, { search = 'fallback' } = {}) {
  let p = String(filePath || '');
  if (p === '~' || p.startsWith('~/')) {
    const home = (await posixSh('printf %s "$HOME"')).stdout.trim();
    if (!home) return null;
    p = p === '~' ? home : `${home}/${p.slice(2)}`;
  }
  if (p.startsWith('/')) {
    // Absolute paths name one file — nothing to sweep for in either mode.
    return (await posixSh(`test -e ${shellEscape(p)}`)).code === 0 ? { path: p } : null;
  }
  // Strip ./ and any trailing slash so the suffix search sees the bare
  // relative path (find prints directories without a trailing /).
  const rel = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!rel) return null;
  const cwd = await getPrimaryCwd();
  const exact = cwd && (await posixSh(`test -e ${shellEscape(cwd + '/' + rel)}`)).code === 0
    ? `${cwd}/${rel}` : null;
  if (exact && search === 'fallback') return { path: exact };
  // ../-relative paths only make sense against the cwd — no suffix to search by.
  if (rel.split('/').includes('..')) return exact ? { path: exact } : null;
  let hits = cwd ? await searchClickedPath(cwd, rel, 5000) : [];
  if (search === 'always' || hits.length === 0) {
    const home = (await posixSh('printf %s "$HOME"')).stdout.trim();
    if (home && home !== cwd) hits = hits.concat(await searchClickedPath(home, rel, 10000));
  }
  const unique = [...new Set(exact ? [exact, ...hits] : hits)].slice(0, CLICK_SEARCH_MAX_CHOICES);
  if (unique.length === 0) return null;
  return unique.length === 1 ? { path: unique[0] } : { choices: unique };
}

function isMarkdownFilePath(filePath) {
  return /\.(?:md|markdown|mdown)$/i.test(String(filePath || ''));
}

// Markdown-viewer file IO — all through the shared POSIX seam. The docs live in
// the repo (WSL on Windows, where the UI process's own fs can't reach them), so
// the shell is both the only thing that works in production and what lets macOS
// exercise the same path. Commands are unix-standard and portable across
// WSL-Linux and macOS — no GNU-only flags: `test`, `find … | head`, `cat`, and
// python3 for stat (GNU `stat -c` vs BSD `stat -f` differ; python3 is already a
// hard dependency via the renderer, and gives mtime+size in one portable call).
// Silent-resolution face of resolveMarkdownChoices: the top choice, which is
// also the first row an ambiguity chooser would show. Every md resolution —
// viewer open, stat/refresh, history resolution — goes through the same discovery
// and ordering, so a gesture that can't show a chooser still lands on the same
// file an explicit click would default to.
async function resolveMarkdownPath(filePath) {
  const resolved = await resolveMarkdownChoices(filePath);
  if (!resolved) return null;
  return resolved.path || resolved.choices[0] || null;
}

// Markdown lookups cover the repo (the shell cwd) plus its sibling folders, so a
// doc in an adjacent repo — ../agent-stream-hub/stream.md, or a bare README.md
// that only lives next door — is clickable too. Rooting the sweep at the cwd's
// parent reaches the repo and every sibling in one find. We refuse to root at a
// top-level directory (/, /Users, /home, /mnt): that would be far too broad.
function markdownSiblingRoot(cwd) {
  const parent = String(cwd || '').replace(/\/+[^/]+\/*$/, '');
  if (!parent || parent === cwd || /^\/[^/]*$/.test(parent)) return cwd;
  return parent;
}

// When the repo and its siblings miss, sweep home. The OS route
// (resolveClickedPath) has always finished with a home sweep, and an .md click
// no longer falls through to it — so the md resolution must reach at least as
// far on its own, or a doc elsewhere under home reads as not found. Skipped
// when the sibling root already is home: that tree was just swept.
async function markdownHomeSweep(root, rel) {
  const home = (await posixSh('printf %s "$HOME"')).stdout.trim();
  if (!home || home === root) return [];
  return (await searchClickedPath(home, rel, 10000)).filter(isMarkdownFilePath);
}

// Resolve a clicked markdown path to either one file or a list of same-named
// candidates under the shell cwd. A bare filename (README.md) that occurs more
// than once in the tree returns { choices } so the renderer can show a picker —
// plain clicks used to silently take the first `find` hit. Absolute / ~ paths
// name one file; a path with separators is specific enough to resolve directly.
// Scope is the repo (cwd) tree plus its sibling folders, then home when those
// miss (node_modules etc. pruned; .git contributes only .git/discussion); the
// show-every-candidate sweep stays reserved for the explicit Alt-click gesture.
async function resolveMarkdownChoices(filePath) {
  if (filePath.startsWith('/')) {
    return (await posixSh(`test -f ${shellEscape(filePath)}`)).code === 0 ? { path: filePath } : null;
  }
  if (filePath === '~' || filePath.startsWith('~/')) {
    const home = (await posixSh('printf %s "$HOME"')).stdout.trim();
    if (!home) return null;
    const abs = filePath === '~' ? home : `${home}/${filePath.slice(2)}`;
    return (await posixSh(`test -f ${shellEscape(abs)}`)).code === 0 ? { path: abs } : null;
  }
  const cwd = await getPrimaryCwd();
  if (!cwd) return null;
  const rel = filePath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!rel) return null;
  const root = markdownSiblingRoot(cwd);
  // A path with separators (docs/README.md) is specific — take the exact hit
  // under cwd, else the nearest suffix match; no chooser.
  if (rel.includes('/')) {
    const exact = `${cwd}/${rel}`;
    if ((await posixSh(`test -f ${shellEscape(exact)}`)).code === 0) return { path: exact };
    const hit = (await posixSh(
      `find ${shellEscape(root)} ${CLICK_SEARCH_PRUNE} -path ${shellEscape('*/' + rel)} -print 2>/dev/null | head -1`,
      { timeout: 10000 })).stdout.trim();
    if (hit) return { path: hit };
    const homeHit = (await markdownHomeSweep(root, rel))[0];
    return homeHit ? { path: homeHit } : null;
  }
  // A bare filename: list every same-named file so duplicates surface a picker.
  // The walk is two-phase with ordering built in: the repo (cwd) tree is swept
  // exhaustively — it is small and it is where duplicates matter — then the
  // sibling neighborhood gets a short wall-clock budget and contributes what it
  // found by the cutoff. A `find | head -N` pipeline can't do this: head waits
  // for N hits or EOF, so find walks the entire neighborhood even when every
  // copy was printed in the first second.
  const hits = (await posixSh(
    `python3 -c ${shellEscape(MARKDOWN_SWEEP_PY)} ${shellEscape(cwd)} ${shellEscape(root)} ${shellEscape(rel)} ${MARKDOWN_SIBLING_BUDGET_S} ${MARKDOWN_CHOICE_MAX}`,
    { timeout: 10000 }))
    .stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (hits.length === 0) {
    const homeHits = await markdownHomeSweep(root, rel);
    if (homeHits.length === 0) return null;
    return homeHits.length === 1 ? { path: homeHits[0] } : { choices: homeHits };
  }
  return hits.length === 1 ? { path: hits[0] } : { choices: hits };
}

async function statMarkdownFilePath(filePath) {
  if (!isMarkdownFilePath(filePath)) return { success: false, error: 'Not a markdown file' };
  const resolved = await resolveMarkdownPath(filePath);
  if (!resolved) return { success: false, error: 'File not found' };
  if (!isMarkdownFilePath(resolved)) return { success: false, error: 'Not a markdown file' };
  // A package renders through the review:// flow, never the md viewer. The
  // click path resolves the same shape first and routes there, so reaching this
  // is a caller that bypassed it.
  if (isReviewPackagePath(resolved)) {
    return { success: false, error: 'Review package: opens via the review:// flow' };
  }
  const r = await posixSh(
    `python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(int(s.st_mtime*1000), s.st_size)' ${shellEscape(resolved)}`);
  if (r.code !== 0) return { success: false, error: 'File not found' };
  const [mtimeMs, size] = r.stdout.trim().split(/\s+/).map(Number);
  return {
    success: true,
    path: resolved,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    size: Number.isFinite(size) ? size : null,
  };
}

// file:// URL prefix that makes an absolute POSIX path loadable by the UI
// process — the viewer uses it to rewrite local image srcs. On Windows the
// docs live inside WSL, reachable only through the \\wsl.localhost UNC host.
let cachedFileUrlRoot = null;
async function getFileUrlRoot() {
  if (cachedFileUrlRoot !== null) return cachedFileUrlRoot;
  if (process.platform !== 'win32') {
    cachedFileUrlRoot = 'file://';
    return cachedFileUrlRoot;
  }
  let distro = process.env.WSL_DISTRO_NAME || '';
  if (!distro) { try { distro = String(await wslExec(['sh', '-lc', 'printf %s "$WSL_DISTRO_NAME"'])).trim(); } catch {} }
  cachedFileUrlRoot = distro ? `file://wsl.localhost/${distro}` : 'file://';
  return cachedFileUrlRoot;
}

ipcMain.handle('read-markdown-file', async (event, filePath) => {
  try {
    const statResult = await statMarkdownFilePath(filePath);
    if (!statResult.success) return statResult;
    const read = await posixSh(`cat -- ${shellEscape(statResult.path)}`);
    if (read.code !== 0) return { success: false, error: 'File not found' };
    return {
      success: true,
      path: statResult.path,
      content: read.stdout,
      mtimeMs: statResult.mtimeMs,
      size: statResult.size,
      imageRoot: await getFileUrlRoot(),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stat-markdown-file', async (event, filePath) => {
  try {
    return await statMarkdownFilePath(filePath);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('resolve-markdown-choices', async (event, filePath) => {
  try {
    return await resolveMarkdownChoices(filePath);
  } catch (e) {
    return null;
  }
});

// Resolve a clicked file path (e.g. a .html review page) to a file:// URL the
// embedded viewer's <webview> can load. WSL-aware on Windows.
// --- Review package rendering (the review:// launch) ---
// Invoke the bundled package renderer (tools/review.py) on the agent-authored
// package, in the reviewed repo, and report where the HTML landed + any structural
// issues (to route back to the agent). The renderer is Python; on Windows it runs
// inside WSL, where git + the repo live.
// Packaged, this file is unpacked from the asar (asarUnpack: tools/**) so an external
// process (WSL python) can actually read it — an in-asar path isn't a real file on
// disk. Point at the .unpacked copy; in dev there's no asar, so the replace no-ops.
const REVIEW_RENDERER = path
  .join(__dirname, '..', 'tools', 'review.py')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function runProc(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

// The ONE platform seam for every git/file probe below. WSL *is* Linux and macOS
// is POSIX, so the command text (`git …`, `test -f`, `cat …`) is byte-identical on
// both; the only difference is how you reach a bash shell — inside WSL on Windows
// (`wsl bash`), directly elsewhere (`bash`). We decide that launcher once, here,
// then append the common `-lc <command>`. So everything above this line is shared
// code, and a macOS run exercises the same path WSL will. (Process-cwd resolution
// is the one thing that stays branched — Linux /proc vs macOS lsof is a different
// mechanism, not the same command behind a different shell.)
function posixSh(command, opts = {}) {
  const [cmd, ...prefix] = bashLauncher();
  if (process.platform === 'win32') {
    // wsl.exe mangles a complex `-lc <script>`: Node marshals the script as one
    // Windows arg, wsl.exe re-splits it by its own rules, and multi-statement /
    // `for…do…done` / `;` forms arrive at bash corrupted — silently (exit 0, no
    // stderr). That is why job-watch's spool read (a `for` loop) never returned
    // events on WSL while branch-watch's single `cd '…' && git …` chain survived.
    // Carry the script as an opaque base64 token inside a simple pipeline, which
    // does survive: the payload has no shell-special bytes left to mangle. The
    // inner bash inherits the outer login shell's exported env (PATH etc.), and
    // the pipeline's exit code is the script's.
    const b64 = Buffer.from(command, 'utf8').toString('base64');
    return runProc(cmd, [...prefix, '-lc', `echo ${b64} | base64 -d | bash`], opts);
  }
  return runProc(cmd, [...prefix, '-lc', command], opts);
}

// Run a git subcommand in `folder` via the POSIX seam (each arg shell-escaped).
// (git is just another command through the seam — same as cat/test/find below.)
function gitIn(folder, args) {
  return posixSh(`cd ${shellEscape(folder)} && git ${args.map(shellEscape).join(' ')}`);
}

// Read a file's text through the seam (repo/.git files live in WSL on Windows,
// where the UI process's fs can't reach them). null if unreadable/missing.
async function catFile(p) {
  const r = await posixSh(`cat -- ${shellEscape(p)}`);
  return r.code === 0 ? r.stdout : null;
}

// The repo is everything before /.git/ (the package lives in the .git store); the
// renderer must run there so `git` resolves the right work tree.
function reviewRepoOf(pkg) {
  return pkg.includes('/.git/') ? pkg.split('/.git/')[0] : path.dirname(pkg);
}

// Run the package renderer in the reviewed repo. Shared POSIX command; the only
// platform bit is the renderer's own path — it lives on the host fs, so on Windows
// it needs translating to a WSL path (wslpath); elsewhere it's already POSIX.
async function runReviewRender(pkg, repo) {
  // wslpath -u turns the host (Windows) script path into a /mnt/c/… WSL path so the
  // WSL python can read it. Pass forward slashes — backslashes get eaten crossing
  // into wsl.exe (C:\…\x.py → C:…x.py); wslpath accepts `/` in a Windows path fine.
  const tool = process.platform === 'win32'
    ? (await wslExec(['wslpath', '-u', REVIEW_RENDERER.replace(/\\/g, '/')])).trim()
    : REVIEW_RENDERER;
  return posixSh(`cd ${shellEscape(repo)} && python3 ${shellEscape(tool)} ${shellEscape(pkg)}`);
}

// review.py does not write the comments store: main is its sole writer. The
// renderer emits its re-anchor verdicts as a <stem>-reanchor.json mutations
// file and main applies them here, under the same per-path lock every other
// store write takes — closing the lost-update window the renderer's own
// read-modify-write used to leave open against a concurrent user action.
async function applyReanchorMutations(pkg) {
  const reanchorPosix = pkg.replace(/\.md$/i, '-reanchor.json');
  const raw = await catFile(reanchorPosix);
  if (raw == null) return;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const list = parsed && Array.isArray(parsed.threads) ? parsed.threads : [];
  if (list.length) {
    const fsStore = await fsPathFromPosix(pkg.replace(/\.md$/i, '-comments.json'));
    await withCommentsLock(fsStore, async () => {
      const store = await loadCommentStore(fsStore);
      const byId = new Map(store.threads.map((t) => [t.id, t]));
      let changed = false;
      for (const m of list) {
        const t = m && byId.get(m.id);
        if (!t) continue;
        if (m.anchor && typeof m.anchor === 'object'
            && JSON.stringify(t.anchor || {}) !== JSON.stringify(m.anchor)) {
          t.anchor = m.anchor;
          changed = true;
        }
        if ((m.anchor_status === 'ok' || m.anchor_status === 'moved' || m.anchor_status === 'lost')
            && t.anchor_status !== m.anchor_status) {
          t.anchor_status = m.anchor_status;
          changed = true;
        }
      }
      if (changed) await saveCommentStore(fsStore, store);
    }).catch(() => {});
  }
  await posixSh(`rm -f ${shellEscape(reanchorPosix)}`);
}

// Auto-refresh: while a review is open, keep it current as the change evolves —
// re-render (which re-anchors existing comments) and reload the viewer only if the
// rendered HTML actually changed (no flicker). Two signals feed it:
//   · the package .md (the agent's prose/ordering) — a directory watch; and
//   · the git diff itself (source edits / new commits) — a polled fingerprint,
//     because raw files can't capture both modes (a range diff ignores the work
//     tree; only a commit moves it) and the agent edits from inside this window,
//     so a focus trigger would never fire for its own changes.
// Comments that can't be re-anchored land as `lost` for the agent to repoint
// (see produce-review-pages.md round-trip).
let reviewSync = null;

function stopReviewSync() {
  if (!reviewSync) return;
  if (reviewSync.pollTimer) { try { clearInterval(reviewSync.pollTimer); } catch {} }
  reviewSync = null;
}

// The scope ref the package's diff rests on (range "A..B"; or a base ref). `git
// diff <scopeArg>` reproduces the embedded diff, so its hash is the source-change
// signal.
async function readScopeArg(pkg) {
  const text = await catFile(pkg);
  if (text == null) return null;
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
  const r = fm.match(/^\s*range:\s*(.+?)\s*$/m);
  if (r) return r[1].trim();
  const b = fm.match(/^\s*base:\s*(.+?)\s*$/m);
  if (b) return b[1].trim();
  return null;
}

async function gitDiffHash(repo, scopeArg) {
  if (!scopeArg) return null;
  const res = await gitIn(repo, ['diff', scopeArg]);
  return crypto.createHash('sha1').update(res.stdout).digest('hex');
}

// The repo's current branch name (real, unsanitized) — for the branch-change
// monitor below. null when the repo isn't a git work tree / detached HEAD.
async function gitCurrentBranch(repo) {
  if (!repo) return null;
  const res = await gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = res.code === 0 ? res.stdout.trim() : '';
  return (b && b !== 'HEAD') ? b : null;
}

// True if the repo has uncommitted TRACKED changes (untracked excluded). Drives
// the review's dirty rejection — re-rendered on toggle so the reject is live.
async function gitDirty(repo) {
  if (!repo) return false;
  const res = await gitIn(repo, ['status', '--porcelain=v2', '--untracked-files=no']);
  if (res.code !== 0) return false;
  // Match real porcelain-v2 change entries (1/2/u), not "any output" — the login-shell
  // git probe can carry profile/tool stdout that would otherwise count as dirty.
  return res.stdout.split('\n').some((l) => /^[12u] /.test(l));
}

// The current HEAD commit — moves on a new commit, branch switch, or reset. The
// review poll watches it so behind/diverged banner changes show without a reopen:
// a fixed range's diff hash doesn't change when HEAD advances past the tip.
async function gitHead(repo) {
  if (!repo) return null;
  const res = await gitIn(repo, ['rev-parse', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : null;
}

async function fileHash(p) {
  const t = await catFile(p);
  return t == null ? null : crypto.createHash('sha1').update(t).digest('hex');
}

async function syncReview() {
  const w = reviewSync;
  if (!w || w.busy) return;
  if ((await posixSh(`test -f ${shellEscape(w.pkg)}`)).code !== 0) return; // package gone
  w.busy = true;
  try {
    await runReviewRender(w.pkg, w.repo);              // writes html + emits re-anchor verdicts
    await applyReanchorMutations(w.pkg);               // main applies them, under the store lock
    w.diffHash = await gitDiffHash(w.repo, w.scopeArg); // rebaseline so the poll won't re-fire
    w.dirty = await gitDirty(w.repo);                   // rebaseline dirty too
    w.mdHash = await fileHash(w.pkg);                   // rebaseline the package fingerprint too
    w.head = await gitHead(w.repo);                     // rebaseline HEAD (behind/diverged banner)
    w.commentsHash = await fileHash(w.commentsPath);    // re-anchor may have moved it — don't re-fire
    const h = await fileHash(w.htmlPath);
    if (h && h !== w.htmlHash) {
      w.htmlHash = h;
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('review-rerendered', { htmlPath: w.htmlPath });
      }
    }
  } catch { /* transient edit/render races: the next signal re-renders */ }
  finally { w.busy = false; }
}

async function startReviewSync(pkg, repo, htmlPath) {
  stopReviewSync();
  reviewDiffKeys.clear(); // a freshly-opened review starts with no baseline (no first-render flash)
  const scopeArg = await readScopeArg(pkg);
  const commentsPath = pkg.replace(/\.md$/i, '-comments.json');
  const journalPath = pkg.replace(/\.md$/i, '-agent.jsonl');
  const w = {
    pollTimer: null, pkg, repo, htmlPath, scopeArg, busy: false, commentsPath, journalPath,
    diffHash: await gitDiffHash(repo, scopeArg),
    dirty: await gitDirty(repo),
    mdHash: await fileHash(pkg),
    htmlHash: await fileHash(htmlPath),
    commentsHash: await fileHash(commentsPath),
    journalHash: await fileHash(journalPath),
    head: await gitHead(repo),
  };
  reviewSync = w;
  // One poll covers every signal — all through the seam, so it works where the
  // files live in WSL (fs.watch can't see a WSL dir from a Windows process):
  //   · the package .md (the agent's prose/ordering) — its content fingerprint;
  //   · the git diff (source edits within scope) — a hash of `git diff <scope>`;
  //   · the dirty flag (uncommitted tracked changes) — for the live banner;
  //   · HEAD (new commit / branch switch) — so the behind/diverged banner updates
  //     in place, since a fixed range's diff doesn't move when HEAD advances.
  w.pollTimer = setInterval(async () => {
    if (reviewSync !== w) return;
    const md = await fileHash(w.pkg);
    const h = await gitDiffHash(w.repo, w.scopeArg);
    const d = await gitDirty(w.repo);
    const head = await gitHead(w.repo);
    if ((md && md !== w.mdHash) || (h && h !== w.diffHash) || d !== w.dirty
        || (head && head !== w.head)) { await syncReview(); return; }
    // Comments-only change (an agent reply, no source/diff change): surface it IN PLACE with a
    // pulse — an rv-refresh, not a re-render/reload. A comment leaves the rendered HTML
    // identical, so nothing would reload otherwise, and a reload would wipe the pulse baseline.
    // The agent's replies arrive as journal appends now, so the journal is watched the same
    // way — either file changing means the merged view the overlay renders has moved.
    const cj = await fileHash(w.commentsPath);
    const aj = await fileHash(w.journalPath);
    if ((cj && cj !== w.commentsHash) || (aj || '') !== (w.journalHash || '')) {
      w.commentsHash = cj || w.commentsHash;
      w.journalHash = aj;
      if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('review-comments-changed');
    }
  }, 2000);
}

ipcMain.handle('render-review-package', async (event, packagePath) => {
  try {
    const pkg = String(packagePath || '');
    if (!/\.md$/i.test(pkg)) return { ok: false, error: 'not a .md review package path' };
    const repo = reviewRepoOf(pkg);
    const htmlPath = pkg.replace(/\.md$/i, '.html');
    // Reject (don't open) only an unusable scope — a base: or a missing range. A dirty
    // tree / commit mismatch still opens; review.py flags it with a red out-of-date
    // banner + a Notify-agent button (no auto-prompt — the user clicks it).
    let reject = false;
    const fmText = await catFile(pkg);
    if (fmText != null) {
      const fm = (fmText.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
      reject = !/^\s*range:\s*\S/m.test(fm);
    }
    const res = await runReviewRender(pkg, repo);
    await applyReanchorMutations(pkg);
    await startReviewSync(pkg, repo, htmlPath); // auto-refresh as package/source evolve
    return {
      ok: res.code === 0,
      reject,
      htmlPath,
      error: res.code !== 0 ? (res.stderr.trim() || `renderer exited ${res.code}`) : undefined,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Cheap existence check for auto-open: does this review package (.md) actually
// exist? Goes through the shared POSIX seam (so it's tested on macOS) and changes
// no state, so a stale or hypothetical review:// path is skipped silently rather
// than disturbing an open review.
ipcMain.handle('review-package-exists', async (_event, packagePath) => {
  const pkg = String(packagePath || '');
  if (!/\.md$/i.test(pkg) || !pkg.startsWith('/')) return false;
  const r = await posixSh(`test -f ${shellEscape(pkg)}`);
  return r.code === 0;
});

// Existence check for file:// viewer candidates. Terminal
// prose — an agent printing an example link — is lexically indistinguishable
// from a printed real link; whether the file is on disk is the check prose
// can't fake.
ipcMain.handle('viewer-file-exists', async (_event, filePath) => {
  const p = String(filePath || '');
  if (!p.startsWith('/')) return false;
  const r = await posixSh(`test -f ${shellEscape(p)}`);
  return r.code === 0;
});

// Scope-1 diff-line pulse: a review reloads wholesale on auto-refresh, wiping the guest, so
// the prior render's new-side line keys live here. Get-and-set — return the prior set (for the
// guest to diff+pulse against) and store the current. A null prior = first render = no flash.
const reviewDiffKeys = new Map();
ipcMain.handle('rv-diff-baseline', (_e, arg) => {
  const id = arg && arg.reviewId;
  if (!id) return null;
  const prior = reviewDiffKeys.get(id) || null;
  reviewDiffKeys.set(id, (arg && Array.isArray(arg.keys)) ? arg.keys : []);
  return prior;
});

// The viewer closed (GC) → stop the review auto-refresh poll/watch.
ipcMain.on('review-viewer-closed', () => { stopReviewSync(); reviewDiffKeys.clear(); });

// --- Lock status (agent-lock) ---
// Poll the session's repo root with git only and show who holds agent-lock's
// lock/agent as a padlock in the chrome bar (src/chrome-bar.js). Status only:
// no notice, no interrupt. The decision is pure (src/lock-status.js); this is
// the git I/O, the holder-window lookup, and the poll. Design, and why there
// are no warnings: .git/discussion/lock-warnings.md.
const LOCK_POLL_HELD_MS = 4000;   // cadence while there is something to show
const LOCK_POLL_QUIET_MS = 12000; // cadence while there is not
// A holder whose window produced no output for this long shows hollow
// ("idle"). Windows refresh lastWorkingAt at most every ACTIVITY_REFRESH_MS
// (30 s), so the threshold sits above that to keep a working holder filled.
const LOCK_IDLE_MS = 60_000;
let lockWatch = null;               // { repoRoot, timer }
let lockState = { state: 'none' };  // the latest decision; rides the chrome-state payload

// The session's primary folder = the live shell cwd (WSL: /proc/<pid>/cwd; else
// the pty's cwd via lsof, falling back to the spawn cwd).
async function getPrimaryCwd() {
  if (process.platform === 'win32') return await getWSLCwd();
  try {
    if (ptyProcess && ptyProcess.pid) {
      const r = await runProc('lsof', ['-a', '-p', String(ptyProcess.pid), '-d', 'cwd', '-Fn']);
      const n = r.stdout.split('\n').find((l) => l.startsWith('n'));
      if (n) return n.slice(1).trim();
    }
  } catch {}
  return ptyStartingCwd();
}

// Last non-empty stdout line: the probes run in a login shell, so profile /
// MOTD noise can precede the value.
function lastLine(stdout) {
  return String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
}

// agent-lock's owner record (.git/agent-lock-owner): key=value lines. `session`
// is the holder's AGENT_SESSION_ID when a host set one (lock-mechanics.md).
function parseOwnerFile(text) {
  const o = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { branch: o.branch || '', session: o.session || '', acquired: o.acquired || '', pid: o.pid || '' };
}

async function readLockOwner(folder) {
  // Resolved the way agent-lock.sh resolves it, so a linked worktree reads its
  // own record.
  const gp = await gitIn(folder, ['rev-parse', '--git-path', 'agent-lock-owner']);
  if (gp.code !== 0) return null;
  let file = lastLine(gp.stdout);
  if (!file) return null;
  if (!file.startsWith('/')) file = `${folder}/${file}`;
  const cat = await posixSh(`cat ${shellEscape(file)} 2>/dev/null`);
  return cat.code === 0 ? parseOwnerFile(cat.stdout) : null;
}

// Resolve a folder to its git repo ROOT (toplevel); null if it isn't a repo /
// can't resolve.
async function gitTopLevel(folder) {
  if (!folder) return null;
  const r = await gitIn(folder, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0) return null;
  const top = lastLine(r.stdout);
  return top && top.startsWith('/') ? top : null;
}

// The git facts the icon needs. Any git error leaves the whole read unknown
// (null), so a transient mid-operation read can't flip the icon.
async function gitLockFacts(folder) {
  if (!folder) return null;
  const head = await gitIn(folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.code !== 0) return null;
  const ref = lastLine(head.stdout);
  const headBranch = ref && ref !== 'HEAD' ? ref : null; // 'HEAD' = detached
  const lock = await gitIn(folder, ['show-ref', '--verify', '--quiet', 'refs/heads/lock/agent']);
  const lockHeld = lock.code === 0;
  const owner = lockHeld ? await readLockOwner(folder) : null;
  return { headBranch, lockHeld, owner };
}

// The live window whose session token is `token`, or null. Liveness is the
// same test the picker and the window cap apply to active records.
function findHolderWindow(token) {
  if (!token) return null;
  try {
    const userDataDir = app.getPath('userData');
    const rec = sessionsLog.findActiveByToken(userDataDir, token);
    if (!rec || !sessionsLog.isSessionActive(rec, { guiSession: getOwnGuiSession() })) return null;
    return rec;
  } catch { return null; }
}

function stopLockWatch() {
  if (lockWatch && lockWatch.timer) { try { clearTimeout(lockWatch.timer); } catch {} }
  lockWatch = null;
}

function startLockWatch() {
  stopLockWatch();
  lockWatch = { repoRoot: null, timer: null };
  lockWatch.timer = setTimeout(pollLockStatus, LOCK_POLL_HELD_MS);
}

async function pollLockStatus() {
  const w = lockWatch;
  if (!w) return;
  let next = lockState;
  try {
    // Anchor to the session's repo ROOT and always probe there, so the shell
    // wandering into a subdir / a different repo / a transient cwd can't make
    // us report the wrong repo. Resolved once + cached; re-resolved if the
    // anchor stops being a repo (it moved).
    const cwd = await getPrimaryCwd();
    if (!w.repoRoot) {
      const top = await gitTopLevel(cwd);
      if (top) w.repoRoot = top;
    }
    const facts = await gitLockFacts(w.repoRoot || cwd);
    if (lockWatch !== w) return; // stopped mid-flight
    if (!facts) {
      w.repoRoot = null; // anchor lost → re-resolve next tick
      next = { state: 'none' };
    } else {
      const session = facts.lockHeld && facts.owner ? facts.owner.session : '';
      const holder = session && session !== agentSessionId ? findHolderWindow(session) : null;
      next = lockStatus.decide(facts, { token: agentSessionId, now: Date.now() }, holder, { idleMs: LOCK_IDLE_MS });
    }
  } catch { /* transient read error: keep what is shown, try again next tick */ }
  finally {
    if (lockWatch === w) {
      if (JSON.stringify(next) !== JSON.stringify(lockState)) {
        lockState = next;
        syncChromeState();
      }
      w.timer = setTimeout(pollLockStatus, lockState.state === 'none' ? LOCK_POLL_QUIET_MS : LOCK_POLL_HELD_MS);
    }
  }
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
function fmtClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function agentNoticeFor(m) {
  // One envelope for everything the host tells the agent: severity word +
  // provenance, then the fact stamped with its observation time ("as of HH:MM"),
  // then the instruction, ending with an idempotence clause (a self-waking CLI
  // may have beaten us). The stamp is inline in the fact (not tucked in the
  // bracket, where it reads as chrome the agent skips) and absolute, not a
  // duration: this is a bracketed paste that waits in the agent's input until
  // its current turn ends, so it may be read minutes later, and "agent quiet"
  // can't tell true idle from a poll-loop gap. An absolute "as of" survives
  // that queueing (a relative "2m ago" would freeze and mislead); the agent
  // gauges staleness against it and re-checks live state before acting. Run
  // durations stay relative — intrinsic, they don't drift.
  const prefix = `[${m.notice ? 'Notice' : 'Warning'} from terminal host]`;
  const at = fmtClock();
  if (m.kind === 'job-report') {
    const parts = m.items.map((it) =>
      `${it.msg}${it.startedMs && it.tsMs ? ` (ran ${fmtDuration(it.tsMs - it.startedMs)})` : ''}`);
    return `${prefix} Background job report (as of ${at}): ${parts.join(' | ')}. Ignore if already handled.`;
  }
  if (m.kind === 'job-vanished') {
    const parts = m.items.map((it) =>
      `"${it.command}"${it.startedMs ? ` (ran ~${fmtDuration(m.lastSeenMs - it.startedMs)})` : ''}`);
    return `${prefix} As of ${at}, a background job you started is gone without a completion report — ${parts.join(', ')}. Its result may be lost; re-establish it if still needed.`;
  }
  if (m.kind === 'job-generic') {
    const parts = m.items.map((it) => `"${it.command}"`).join(', ');
    return `${prefix} A background job you started (${parts}) exited while you were idle (as of ${at}). Check its result and continue; ignore if already handled.`;
  }
  return `${prefix} As of ${at} — ${m.text}`;
}

// --- Background-job monitor (the job-done nudge) ---
// Contract: job-events.md; pure logic + tests: job-watch.js. Each poll
// reads the spool (cheap) and, only once the agent has gone quiet, takes one
// ps snapshot for the vanish tiers. Notices are bracketed-paste submissions.
// A completion event is delivered only to an agent that was idle when the
// job finished and stays idle JOB_IDLE_MS after it; an agent awake at the
// finish, or woken within that window, already has the result from its own
// environment (or is mid-turn, where a queued paste would land late and
// read as a stale second report), so the event is consumed as superseded.
// The fuse gates only the vanish tiers, which infer a job's death from a
// process's absence and so need the agent settled-idle first, lest mid-work
// churn false-fire.
const JOB_IDLE_MS = Number(process.env.AGENT_TERM_JOB_IDLE_MS) || 120_000;
const JOB_FUSE_MS = Number(process.env.AGENT_TERM_JOB_FUSE_MS) || 15 * 60_000;
const JOB_POLL_MS = Number(process.env.AGENT_TERM_JOB_POLL_MS) || 60_000;
// This window's session token (job-events.md; agent-lock records it as
// session= in its owner file). Fresh per process, then replaced by the stored
// one when this window resumes a recorded session, so the token means the
// session, not the process (resumeFromSession).
let agentSessionId = crypto.randomBytes(4).toString('hex');
// Spool path resolves inside the shell (WSL on Windows) — same rule the
// writing scripts use, so both sides land on the same directory.
const JOB_SPOOL = '"${TMPDIR:-/tmp}/agent-events"';
let jobWatchState = null;
let jobWatchTimer = null;
let jobWatchPending = new Map(); // event file → finish time fixed at first sight
let jobWatchPrevPollAt = 0;      // last COMPLETED poll (a skipped cycle must not advance it)

async function jobShellPid() {
  if (process.platform !== 'win32') return ptyProcess ? ptyProcess.pid : null;
  if (!wslPidFile) return null;
  try { return Number(await wslExec(['cat', wslPidFile])) || null; }
  catch { return null; }
}

async function pollJobWatch() {
  const timerAtEntry = jobWatchTimer;
  try {
    if (!ptyProcess) return;
    const now = Date.now();
    const agentQuietFor = now - lastPtyOutputTime;
    const composing = userComposing();
    const inputAtEntry = lastInputTime;
    // The spool is read every poll — an event ripens by age even mid-turn,
    // and its delivery then rides the CLI's own input queue. The ps
    // snapshot only matters once the agent has been quiet long enough for
    // a stable vanish baseline.
    const wantPs = agentQuietFor >= JOB_IDLE_MS;
    const shellPid = wantPs ? await jobShellPid() : null;
    const [psR, spoolR] = await Promise.all([
      shellPid
        ? posixSh('ps -axo pid=,ppid=,pgid=,stat=,etime=,command=')
        : Promise.resolve({ stdout: '', code: null }),
      posixSh(`d=${JOB_SPOOL}; if [ -d "$d" ]; then for f in "$d"/*.event; do [ -f "$f" ] || continue; printf '===FILE %s\\n' "$f"; cat "$f"; done; fi`),
    ]);
    const rows = jobWatch.parsePs(psR.stdout);
    const agentPid = shellPid ? jobWatch.findAgentPid(rows, shellPid) : null;
    // Trust the snapshot for vanish detection only if ps actually ran and
    // exited cleanly — execFile reports a non-zero exit (or a wsl.exe spawn
    // failure) as a non-zero code. A null shellPid means we skipped ps
    // (shell pid unresolvable, e.g. WSL cold-start): no snapshot, not a
    // failed one. Either way an absent snapshot must not read as a mass
    // vanish (see evaluate). Event delivery does not depend on ps.
    const psOk = shellPid != null && psR.code === 0;
    const snapshot = {
      labeled: jobWatch.selectLabeled(rows, agentSessionId),
      generic: jobWatch.selectGeneric(rows, agentPid, agentSessionId),
    };
    const events = jobWatch.parseEvents(spoolR.stdout)
      .filter((e) => e.session === agentSessionId);
    const res = jobWatch.evaluate(
      { now, agentQuietFor, agentActiveAt: lastAgentOutputTime, composing, snapshot, events,
        pending: jobWatchPending, prevPollAt: jobWatchPrevPollAt, windowStartAt: ptyStartedAt,
        quietMs: JOB_IDLE_MS, idleMs: JOB_IDLE_MS, fuseMs: JOB_FUSE_MS, psOk },
      jobWatchState);
    // The composing check ran before the shell reads above; a first
    // keystroke could have landed since. Drop the cycle wholesale rather
    // than splice a paste into a steer being typed — the spool still holds
    // the events and the next poll re-resolves.
    if (lastInputTime !== inputAtEntry) return;
    jobWatchState = res.state;
    jobWatchPending = res.pending;
    jobWatchPrevPollAt = now;
    if (res.superseded.length) {
      log('[job-watch] superseded (agent active at or after the finish): ' + res.superseded.join(', '));
    }
    if (res.remove.length) {
      await posixSh(`rm -f ${res.remove.map(shellEscape).join(' ')}`);
    }
    if (res.notice) {
      // The prompt carries the minimal signal (see agentNoticeFor); full
      // detail — absolute timestamps, per-item data — lives here in the
      // host log, and the sessions-log record feeds a future past-notices
      // viewer. The transcript records the injected line in-band.
      log('[job-watch] notice: ' + res.notice.kind + ' ' + JSON.stringify(res.notice.items));
      const text = agentNoticeFor(res.notice);
      writeAsBracketedPasteSubmission(text);
      if (sessionIndex !== null) {
        sessionsLog.appendEvent(app.getPath('userData'),
          { e: 'host-notice', id: sessionIndex, kind: res.notice.kind, text, items: res.notice.items });
      }
    }
  } catch { /* transient read error: try again next tick */ }
  finally {
    if (jobWatchTimer === timerAtEntry) {
      jobWatchTimer = setTimeout(pollJobWatch, JOB_POLL_MS);
    }
  }
}

function startJobWatch() {
  if (jobWatchTimer) clearTimeout(jobWatchTimer);
  jobWatchState = null;
  jobWatchPending = new Map();
  jobWatchPrevPollAt = 0;
  log(`[job-watch] armed (session ${agentSessionId}, poll ${JOB_POLL_MS}ms, fuse ${JOB_FUSE_MS}ms)`);
  // GC events no session ever claimed (their window is gone for good).
  posixSh(`find ${JOB_SPOOL} -name '*.event' -mtime +7 -delete 2>/dev/null || true`);
  jobWatchTimer = setTimeout(pollJobWatch, JOB_POLL_MS);
}

// review:// capture → record the reviewed repo's branch for the picker's deep
// search (history only; the warnings come from the primary-folder poll above).
ipcMain.handle('capture-review-branch', async (event, reviewUrl) => {
  try {
    const pkg = decodeURIComponent(String(reviewUrl || '').replace(/^review:\/\//i, '')).trim();
    if (!pkg) return { ok: false };
    const repo = reviewRepoOf(pkg);
    const branch = await gitCurrentBranch(repo);
    if (!branch) return { ok: false };
    sessionsLog.appendEvent(app.getPath('userData'), { e: 'branches', id: sessionIndex, repo, branch });
    return { ok: true, repo, branch };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('resolve-file-url', async (event, filePath) => {
  try {
    const resolved = await resolveClickedPath(filePath);
    if (!resolved) return { success: false, error: 'File not found' };
    // The web viewer has no chooser; an ambiguous search takes the first hit,
    // which is what the old first-match find did.
    const abs = resolved.path || resolved.choices[0];
    if (process.platform === 'win32') {
      let distro = process.env.WSL_DISTRO_NAME || '';
      if (!distro) { try { distro = String(await wslExec(['sh', '-lc', 'printf %s "$WSL_DISTRO_NAME"'])).trim(); } catch {} }
      const enc = abs.split('/').map((s) => encodeURIComponent(s)).join('/');
      return { success: true, url: distro ? `file://wsl.localhost/${distro}${enc}` : `file://${enc}` };
    }
    return { success: true, url: require('url').pathToFileURL(abs).href };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read a review page's comment store (review/<slug>-comments.json). Takes a
// file:// URL (derived by the viewer from the page URL); a missing file means
// "no comments yet" (not an error). Only ever reads a *-comments.json path.
// Send waves per comments store — session memory only, like the diff-pulse
// baseline (reviewDiffKeys) and the md viewer's unsent queue: "this terminal's
// agent has been pinged" is a fact about the live session and dies with it, so
// a restart correctly re-offers Send to the new agent. Host UI state, not
// contract — the store file stays pure conversation (protocol.md is untouched).
//
// The boundary is ORDINAL, not temporal. Every question the overlay asks is
// "how many sends ago", and a wall clock answers a different question: the user
// goes for coffee mid-review and comes back, and elapsed time has moved while
// the work has not. A count of sends is the review's own clock — it ticks when
// work is handed over and stands still otherwise, which is exactly the axis the
// card ladder is drawn on. It also sidesteps clock hazards for free: NTP steps,
// and the agent process stamping its own messages from a different clock (a
// different OS instance under WSL).
//
// Two different facts live here, and only one of them is session-scoped:
//
//   "these words left the user's hands" — a fact about the CONVERSATION, and
//     durable. It goes in the store: a send stamps every user message it hands
//     over with `turn`, the md store's field and semantics (turn ticks once per
//     user send). An un-stamped user message has never been sent, and that
//     stays true across a restart. This is what Discard hangs off — deleting a
//     thread the agent already received would take back words it has.
//
//   "THIS session's agent has been pinged" — a fact about a PROCESS, and it
//     dies with it. A ping is a paste into a running CLI; relaunch and the new
//     agent has never seen any of it, so every unanswered thread should offer
//     Send again. That is sessionFirstTurn: the store turn of this session's
//     first send (0 = none yet). A message stamped below it went to an agent
//     that no longer exists.
//
// Collapsing the two into one session-only counter was wrong in the direction
// that loses work: after a relaunch the store could not tell "never sent" from
// "sent last session", so Discard reappeared on threads the agent already had.
// The md viewer never had that bug because sending is what puts a comment in
// its store at all — presence IS the durable record. This store commits on
// click-away, so it needs the stamp to say the same thing.
//
// resolvedAtSend (ids already closed at the latest send) stays session memory:
// it tracks what the USER has read, not what the agent received.
const reviewSends = new Map();
function reviewSendState(p) {
  const s = reviewSends.get(p);
  return {
    sessionFirstTurn: (s && s.firstTurn) || 0,
    resolvedAtSend: (s && s.resolvedAtSend) || [],
  };
}

// --- Stall watch: one auto-reminder when comment resolution stalls ---
// Armed per store on every submitted send (md and review alike). A send is the
// user's explicit request, so one re-ping on a stall is delivery retry of that
// request, not new intent — and it only fires while the user has stayed
// hands-off since the send (any terminal input disarms; the user took the
// wheel, and typing to the agent IS the manual reminder). Decision rules and
// thresholds live in comment-stall.js; this owns the clocks and the IO.
const STALL_POLL_MS = 5000;
const stallWatches = new Map(); // store fs path → { sendTime, coveredIds, remindText }
let stallTimer = null;

function armStallWatch(p, { coveredIds, remindText }) {
  if (!Array.isArray(coveredIds) || !coveredIds.length) return;
  // A newer send replaces the old watch wholesale — its covered set is current.
  stallWatches.set(p, { sendTime: Date.now(), coveredIds, remindText });
  if (!stallTimer) {
    stallTimer = setInterval(() => { tickStallWatches().catch(() => {}); }, STALL_POLL_MS);
  }
}

async function tickStallWatches() {
  for (const [p, w] of [...stallWatches]) {
    try {
      const { merged } = await mergedCommentStore(p);
      const covered = merged.threads.filter((t) => w.coveredIds.includes(t.id));
      const decision = decideStall(w, {
        now: Date.now(),
        lastInputTime,
        lastAgentOutputTime,
        coveredThreads: covered,
      });
      if (decision === 'wait') continue;
      stallWatches.delete(p); // every other outcome ends the watch — one shot
      if (decision === 'remind' && pasteAgentPing(w.remindText)) {
        const count = unaddressedCount(covered);
        log(`[stall] reminded agent — ${count} covered thread(s) unaddressed`);
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stall-reminder', { count });
          }
        } catch {}
      }
    } catch {
      stallWatches.delete(p); // unreadable store: the watch has nothing to stand on
    }
  }
  if (!stallWatches.size && stallTimer) { clearInterval(stallTimer); stallTimer = null; }
}

ipcMain.handle('read-review-comments', async (event, fileUrl) => {
  try {
    const { fileURLToPath } = require('url');
    let p;
    try { p = fileURLToPath(fileUrl); } catch { p = String(fileUrl || ''); }
    if (!/-comments\.json$/i.test(p)) return { success: false, error: 'not a comments store' };
    const stamps = reviewSendState(p);
    // Merged view: store + agent journal. The overlay renders exactly this.
    const { merged } = await mergedCommentStore(p);
    return { success: true, path: p, data: merged, ...stamps };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Self-review comment store: writes (Track B phase 3) ---
// Main is the SOLE writer of <slug>-comments.json. The in-page overlay (the
// webview preload) sends deltas — add-thread / add-message / set-status — and
// main does an id-keyed read-modify-write so the JSON snapshot stays the single
// source of truth. A per-path promise chain serializes concurrent writes so two
// rapid deltas can't clobber each other.
const commentsLocks = new Map();
function withCommentsLock(p, fn) {
  const prev = commentsLocks.get(p) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  commentsLocks.set(p, run.then(() => {}, () => {}));
  return run;
}

// file:// URL -> on-disk path for IO (UNC \\wsl.localhost\... on Windows, which
// Node fs reads/writes fine; POSIX path on mac/linux).
function commentsPathFromUrl(fileUrl) {
  const { fileURLToPath } = require('url');
  let p;
  try { p = fileURLToPath(fileUrl); } catch { p = String(fileUrl || ''); }
  return p;
}

// file:// URL -> the path the *agent* (running inside the WSL shell) should read:
// the WSL POSIX path, not the Windows UNC form.
function agentPathFromCommentsUrl(fileUrl) {
  const m = /^file:\/\/wsl\.localhost\/[^/]+(\/.*)$/i.exec(String(fileUrl || ''));
  if (m) return decodeURIComponent(m[1]);
  return commentsPathFromUrl(fileUrl);
}

async function loadCommentStore(p) {
  let raw;
  try { raw = await fs.promises.readFile(p, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, threads: [] }; throw e; }
  const store = JSON.parse(raw);
  if (!store || typeof store !== 'object') return { version: 1, threads: [] };
  if (!Array.isArray(store.threads)) store.threads = [];
  return store;
}

async function saveCommentStore(p, store) {
  // The markdown store lives in a .agent-threads folder beside the document, so
  // the first comment on a document creates it. path.dirname is the host's, and
  // p is already a host path — the WSL UNC form on Windows, where creating the
  // folder crosses the same boundary the write itself does. Review stores land
  // in a folder produce-review already made, so this is a no-op there.
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, p);
}

// The agent's replies/dispositions live in the append-only journal beside the
// store (agent-journal.js; contract.md Message rules). Nothing folds them into
// the store — every read path merges at read time, so the store file stays
// wholly main's and the journal wholly the agent's.
async function readJournalEvents(p) {
  const jp = journalPathForStore(p);
  if (!jp) return [];
  try { return parseJournal(await fs.promises.readFile(jp, 'utf8')); }
  catch { return []; } // missing journal = agent has said nothing yet
}

// store file + journal → the merged view every renderer gets. `store` and
// `events` ride along for write paths that need the raw parts.
async function mergedCommentStore(p) {
  const store = await loadCommentStore(p);
  const events = await readJournalEvents(p);
  return { store, events, merged: mergeStoreWithJournal(store, events) };
}

let commentThreadSeq = 0;
function newThreadId() {
  commentThreadSeq += 1;
  return 't' + Date.now().toString(36) + '-' + commentThreadSeq.toString(36);
}

// Guard: only ever touch a *-comments.json path (mirrors the read handler).
function validCommentsPath(p) { return /-comments\.json$/i.test(p); }

// A thread is still the user's to retract or rewrite only while it is wholly
// un-sent and the agent has never spoken: no message carrying a turn stamp
// (a stamp means a send covered it) and no agent journal events. This is the
// overlay's threadWhollyUnsent enforced server-side, so a stale guest render
// can't delete words the agent has. Returns the refusal, or null when the
// thread is still retractable.
function threadRetractError(t, events) {
  if ((t.messages || []).some((m) => Number.isFinite(m.turn))) {
    return 'already sent to the agent — reply instead';
  }
  if (threadHasAgentEvents(events, t.id)) {
    return 'the agent has this thread — reply instead';
  }
  return null;
}

ipcMain.handle('rv-add-thread', async (event, { commentsUrl, anchor, body, note } = {}) => {
  const p = commentsPathFromUrl(commentsUrl);
  if (!validCommentsPath(p)) return { success: false, error: 'not a comments store' };
  const text = String(body == null ? '' : body).trim();
  if (!text) return { success: false, error: 'Empty comment' };
  const a = anchor || {};
  // A commit-message edit thread's optional note: rides as a SECOND user
  // message so the [Edit] envelope stays pure diff (md-add-threads' rule).
  const noteText = String(note == null ? '' : note).trim();
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      const id = newThreadId();
      const ts = Date.now();
      store.threads.push({
        id,
        anchor: {
          path: a.path || '',
          side: a.side || '',
          line: a.line != null ? String(a.line) : '',
          snippet: a.snippet || '',
          // Enclosing unit for an ambiguous (short/repeated) quote — disambiguates
          // re-anchoring; empty when the snippet stands alone.
          context: a.context || '',
          // The selection covered a whole block (double-click) → the placed
          // highlight should cover the block, not just the capped snippet.
          wholeBlock: !!a.wholeBlock,
          // For prose/region anchors: the agent's nearest authored heading, so a
          // ping can locate the spot in the agent's own words (not the host's
          // render-internal "(note N)" label, which the agent never wrote).
          heading: a.heading || '',
        },
        // No `status` field: main only ever wrote 'open', so the store carries
        // none and readers default an absent status to open. Effective status
        // is the merge's business — journal events set it, and a user
        // follow-up newer than a journal `resolved` derives the reopen.
        anchor_status: 'ok',
        messages: [
          { author: 'user', body: text, ts },
          ...(noteText ? [{ author: 'user', body: noteText, ts }] : []),
        ],
      });
      await saveCommentStore(p, store);
      return { success: true, data: mergeStoreWithJournal(store, await readJournalEvents(p)), threadId: id };
    } catch (e) { return { success: false, error: e.message }; }
  });
});

// Revision of a pending commit-message edit (the user re-entered the block):
// replace the envelope, and the note in the envelope+note shape, while the
// thread is still wholly the user's — the same guard as discard below. The
// fresh ts keeps the thread ahead of the sent boundary (needs-send).
ipcMain.handle('rv-update-edit-thread', async (event, { commentsUrl, threadId, body, note } = {}) => {
  const p = commentsPathFromUrl(commentsUrl);
  if (!validCommentsPath(p)) return { success: false, error: 'not a comments store' };
  const text = String(body == null ? '' : body).trim();
  if (!text) return { success: false, error: 'Empty edit' };
  const noteText = String(note == null ? '' : note).trim();
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      const events = await readJournalEvents(p);
      const t = store.threads.find((x) => x.id === threadId);
      if (!t) return { success: false, error: 'thread not found' };
      const sealed = threadRetractError(t, events);
      if (sealed) return { success: false, error: sealed };
      const ts = Date.now();
      t.messages[0] = { author: 'user', body: text, ts };
      if (t.messages.length <= 2) {
        if (noteText) t.messages[1] = { author: 'user', body: noteText, ts };
        else t.messages.length = 1;
      }
      await saveCommentStore(p, store);
      return { success: true, data: mergeStoreWithJournal(store, events) };
    } catch (e) { return { success: false, error: e.message }; }
  });
});

// Undo for a pending commit-message edit: drop its thread while it is still
// wholly the user's — open, every message user-authored. Once the agent has
// spoken the record is a conversation and undo becomes a follow-up instead.
ipcMain.handle('rv-discard-thread', async (event, { commentsUrl, threadId } = {}) => {
  const p = commentsPathFromUrl(commentsUrl);
  if (!validCommentsPath(p)) return { success: false, error: 'not a comments store' };
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      const events = await readJournalEvents(p);
      const i = store.threads.findIndex((x) => x.id === threadId);
      if (i === -1) return { success: false, error: 'thread not found' };
      const sealed = threadRetractError(store.threads[i], events);
      if (sealed) return { success: false, error: sealed };
      store.threads.splice(i, 1);
      await saveCommentStore(p, store);
      return { success: true, data: mergeStoreWithJournal(store, events) };
    } catch (e) { return { success: false, error: e.message }; }
  });
});

ipcMain.handle('rv-add-message', async (event, { commentsUrl, threadId, body } = {}) => {
  const p = commentsPathFromUrl(commentsUrl);
  if (!validCommentsPath(p)) return { success: false, error: 'not a comments store' };
  const text = String(body == null ? '' : body).trim();
  if (!text) return { success: false, error: 'Empty comment' };
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      const t = store.threads.find((x) => x.id === threadId);
      if (!t) return { success: false, error: 'thread not found' };
      if (!Array.isArray(t.messages)) t.messages = [];
      // The reopen is derived, never written: this follow-up postdates any
      // journal `resolved`, so the merge's recency rule reopens the thread.
      t.messages.push({ author: 'user', body: text, ts: Date.now() });
      await saveCommentStore(p, store);
      return { success: true, data: mergeStoreWithJournal(store, await readJournalEvents(p)) };
    } catch (e) { return { success: false, error: e.message }; }
  });
});

// No rv-set-status: the agent owns `status` (contract.md) and writes it in the
// store directly. Leaving a host channel for it would let the viewer overrule
// the one judgement only the agent can make.

// Ping the running agent to read+address the comments. Reuses the inline-comment
// submission path (bracketed paste into the active CLI). The path handed to the
// agent is the WSL POSIX path it can actually open.
// Describe WHERE a comment is anchored, in the AGENT's own terms. Code diffs are
// a real file + new-side line. Prose/region anchors must never echo the host's
// render-internal "(note N)" label — the agent authors only markdown and never
// runs the renderer — so we locate by the heading it wrote. The quoted text is
// added separately by the caller so the message can be multi-line like md/terminal.
// The review's banners carry a "Notify agent" button. Clicking it forwards a
// fixed prompt to the agent — chosen by `kind` (the page sends only the kind,
// never free text, so a page can't inject an arbitrary prompt).
const REVIEW_REGEN_PROMPTS = {
  refresh: 'This review is out of date — commit any uncommitted changes, then update the review package to the latest commit.',
  diverged: "HEAD has diverged from this review's range (likely a different branch). Confirm the intended branch, then update the review package to the latest commit — or switch back.",
  scope: "This review's scope is unusable — a base: scope (base → working tree) or a missing range. Set a committed `range: A..B` (pinned refs, not HEAD) in the package; the review updates once it's valid.",
};
// The `errors` prompt is a pointer, like every other host → agent message: the
// renderer writes the directives that failed as written beside the page as
// <stem>-errors.json, and the package is the one this host is syncing. The list
// itself never rides in the prompt (it changes with every re-render, and the agent
// never runs the renderer, so the file is the only place it can read it). This is
// not the coverage nudge that was dropped — a changed line no directive shows is
// never an error.
function reviewRegenPrompt(kind) {
  if (kind !== 'errors') return REVIEW_REGEN_PROMPTS[kind] || REVIEW_REGEN_PROMPTS.refresh;
  const pkg = reviewSync && reviewSync.pkg;
  const subject = pkg ? `Review package ${pkg}` : "This review's package";
  const list = pkg ? pkg.replace(/\.md$/i, '-errors.json') : 'its -errors.json sibling';
  return `${subject} has directive errors (a :::diff/:::code line that fails to parse, a bad line range, or an embed with nothing to show). `
    + `Read the list in ${list}, fix each one in the package, and save; the open review re-renders on its own.`;
}
ipcMain.handle('rv-regenerate', async (event, { kind } = {}) => {
  const ok = pasteAgentPing(reviewRegenPrompt(kind));
  return ok ? { success: true } : { success: false, error: 'No active terminal process' };
});

// Clipboard text for the review guest's Cmd/Ctrl+V type-to-comment: the
// sandboxed <webview> preload has no clipboard module of its own.
ipcMain.handle('rv-clipboard-text', () => clipboard.readText());

ipcMain.handle('rv-send-to-agent', async (event, { commentsUrl, toPrompt = false } = {}) => {
  const p = commentsPathFromUrl(commentsUrl);
  if (!validCommentsPath(p)) return { success: false, error: 'not a comments store' };
  const agentPath = agentPathFromCommentsUrl(commentsUrl);
  // Lead with "My comment(s) on review://<package>" to match the md ("My comments
  // on markdown document:") and terminal ("My comment on terminal output:") leads.
  const pkg = agentPath.replace(/-comments\.json$/i, '.md');
  // Pointer only — the comments store is the single source of truth, and the
  // agent must open it anyway to reply, so the prompt never repeats its content
  // (the just-composed thread isn't special, merely last). No count either:
  // the store keeps changing between this paste and the agent's read (an
  // earlier send may get resolved first), so a number is stale on arrival and
  // sends the agent hunting for threads that no longer exist. "The open
  // threads" stays true for whatever the store holds at read time. The header
  // still pluralizes by the count at paste time (its convention carries no
  // number, so it can't mislead the same way).
  let n = 0;
  let coveredIds = [];
  try {
    const { merged } = await mergedCommentStore(p);
    const open = merged.threads.filter((t) => (t.status || 'open') === 'open');
    n = open.length;
    coveredIds = open.map((t) => t.id);
  } catch { n = 0; }
  // Prompts point, they don't teach: the journal schema, the store's
  // read-only rule, and commit-before-resolve all live in the runbook the
  // pointer names (produce-review.md's Round-trip section), so the review
  // send is the same short sentence as the md send. Resolution failure asks
  // the user, exactly like the md preflight — nothing is written before a
  // Cancel.
  const runbook = await resolveReviewRunbook(agentPath);
  if (!runbook && !(await askSendWithoutRunbook(event.sender,
    `${runbookMissingError(REVIEW_THREADS_RUNBOOK, 'store')}\n\nSend anyway? The agent `
      + 'handles your comments from the store, without the shared contract.'))) {
    return { canceled: true };
  }
  const addressLine = threadsAddressLine(agentPath, runbook);
  const text = [commentHeader(`review://${pkg}`, n || 1), addressLine].join('\n');
  const ok = pasteAgentPing(text, { toPrompt });
  if (!ok) return { success: false, error: 'No active terminal process' };
  // Record the send IN the store, after the ping actually went out: tick the
  // turn and stamp every user message this hands over. A failed stamp only
  // costs a re-send, where stamping first and failing to paste would leave
  // threads claiming they were sent.
  let turn = 0;
  let resolvedAtSend = [];
  await withCommentsLock(p, async () => {
    try {
      const s = await loadCommentStore(p);
      turn = (Number.isFinite(s.turn) ? s.turn : 0) + 1;
      s.turn = turn;
      // "Already closed at this send" reads the MERGED state — resolutions
      // live only in the journal.
      const merged = mergeStoreWithJournal(s, await readJournalEvents(p));
      resolvedAtSend = merged.threads.filter((t) => t.status === 'resolved').map((t) => t.id);
      s.threads.forEach((t) => (t.messages || []).forEach((m) => {
        if ((m.author || 'user') === 'user' && !Number.isFinite(m.turn)) m.turn = turn;
      }));
      await saveCommentStore(p, s);
    } catch { /* the ping is out; an unstamped send just offers Send again */ }
  });
  const was = reviewSends.get(p);
  reviewSends.set(p, { firstTurn: (was && was.firstTurn) || turn, resolvedAtSend });
  // Delivery retry: if the agent goes idle with covered threads unaddressed
  // and the user stays hands-off, one reminder re-pings it (comment-stall.js).
  // To prompt hands delivery to the user's own typing, so it never arms.
  if (!toPrompt) {
    armStallWatch(p, {
      coveredIds,
      remindText: 'Reminder: open review comment threads remain unaddressed.\n' + addressLine,
    });
  }
  return { success: true, ...reviewSendState(p) };
});

// --- Markdown document threads (md viewer → sidecar store; the agent-facing
// contract is ~/agent-threads/contract.md + md/user-intent.md) ---

// Absolute POSIX path → a path Node fs can open: unchanged on mac/linux, the
// \\wsl.localhost UNC form on Windows (the docs live inside WSL).
async function fsPathFromPosix(posixPath) {
  const root = await getFileUrlRoot();
  if (!root.startsWith('file://wsl.localhost/')) return posixPath;
  return uncFromPosix(posixPath, root.slice('file://wsl.localhost/'.length));
}

// Agent-related runbook repos can be vendored inside the session's repo, sit
// beside it, or live anywhere up the tree. Anchor on where the session actually
// is — the pty's current cwd AND its stable starting cwd (where AgentTerm
// launched) — resolving each to its git repo root, or to the directory itself
// when it isn't a repo. repoRunbookRoots then walks each anchor's full ancestor
// chain. This resolves the session's own repo, not AgentTerm's app location
// (they coincide only when using AgentTerm to develop itself). Failure only
// drops these fallbacks; document/HOME resolution remains.
async function currentRepoRunbookRoots() {
  try {
    // repoRunbookRoots needs absolute POSIX paths. getPrimaryCwd is POSIX on both
    // platforms (the WSL cwd on Windows); ptyStartingCwd is a Win32 path on
    // Windows, so the filter drops it there — the current cwd still anchors.
    const cwds = [await getPrimaryCwd(), ptyStartingCwd()]
      .filter((c) => typeof c === 'string' && c.startsWith('/'));
    const roots = [];
    const seen = new Set();
    for (const cwd of cwds) {
      const base = (await gitTopLevel(cwd)) || cwd;
      for (const r of repoRunbookRoots(base)) {
        if (!seen.has(r)) { seen.add(r); roots.push(r); }
      }
    }
    return roots;
  } catch {
    return [];
  }
}

// One resolver for every host-located runbook: the governed file's direct
// ancestor chain is closest-first, followed by ordered fallbacks walking the
// session repo's own ancestor chain (vendored in, beside, up the tree) and then
// under HOME. One shell pass returns the first existing candidate.
async function resolveRunbook(referenceFile, relativeRunbookPath) {
  const [homeProbe, repoRoots] = await Promise.all([
    posixSh('printf %s "$HOME"'),
    currentRepoRunbookRoots(),
  ]);
  const home = homeProbe.stdout.trim();
  const fallbackRoots = [...repoRoots, home].filter(Boolean);
  const candidates = orderedRunbookCandidates({
    referenceFile,
    relativeRunbookPath,
    fallbackRoots,
  });
  const probe = await posixSh(
    `for p in ${candidates.map(shellEscape).join(' ')}; do if [ -f "$p" ]; then printf %s "$p"; exit 0; fi; done; exit 1`,
  );
  if (probe.code !== 0) return null;
  return probe.stdout.trim();
}

const MD_THREADS_RUNBOOK = 'agent-threads/md/user-intent.md';
const REVIEW_THREADS_RUNBOOK = 'agent-threads/code/produce-review.md';

// Returns the resolved path, or null. The pointer names the winner so the
// agent reads the copy that governs this document.
function resolveMdRunbook(doc) {
  return resolveRunbook(doc, MD_THREADS_RUNBOOK);
}

// Same ladder for the review surface, anchored on the store (its ancestor
// chain climbs through .git/review/… to the repo and beyond).
function resolveReviewRunbook(storePath) {
  return resolveRunbook(storePath, REVIEW_THREADS_RUNBOOK);
}

function runbookMissingError(relPath, governed) {
  return `agent-threads is not installed: no ${relPath} found from the `
    + `session repo root up the tree, above the ${governed}, or under HOME`;
}

// The runbook was not found anywhere on the ladder: ask whether to send
// anyway. Shared by the md preflight and the review send — both run ahead of
// any write, so Cancel leaves nothing changed.
async function askSendWithoutRunbook(sender, detail) {
  const win = BrowserWindow.fromWebContents(sender) || BrowserWindow.getFocusedWindow();
  const opts = {
    type: 'warning',
    buttons: ['Send anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'agent-threads runbook not found',
    detail,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

// Called before the send writes anything. Resolves the runbook; if it is not
// found from the session repo up the tree, above the document, or under HOME,
// asks the user whether to send anyway. The confirmation lives here, ahead of
// any document write, so Cancel leaves nothing changed.
ipcMain.handle('md-runbook-preflight', async (event, { docPath } = {}) => {
  const doc = String(docPath || '');
  if (!doc.startsWith('/') || !isMarkdownFilePath(doc)) return { canceled: true };
  const runbook = await resolveMdRunbook(doc);
  if (runbook) return { runbook };
  const ok = await askSendWithoutRunbook(event.sender,
    `${runbookMissingError(MD_THREADS_RUNBOOK, 'document')}\n\nSend anyway? The agent `
      + 'handles your edits and comments from the store, without the shared contract.');
  return ok ? { runbook: null, acked: true } : { canceled: true };
});

// The three-fact pointer: doc path, store path, resolved runbook. Content
// never rides along — the store is the single source of truth. No open count
// either: the store keeps changing between paste and the agent's read, so a
// number is stale on arrival; "the open threads" stays true for whatever the
// store holds when the agent looks. The lead line is picked from a fixed enum
// (the renderer never injects free text into the prompt).
const MD_POINTER_LEADS = {
  comments: 'My comments on markdown document:',
  edits: 'My edits on markdown document:',
  mixed: 'My edits and comments on markdown document:',
};

// One sentence for both surfaces: the md pointer and the review send close
// with the same line, store path + governing runbook.
function threadsAddressLine(storePosix, runbook) {
  return runbook
    ? `Read the open threads in ${storePosix} and address them per ${runbook}.`
    // Explicit-ack send without the runbook (not found): no contract reference,
    // the agent addresses the threads on its own reading.
    : `Read the open threads in ${storePosix} and address them.`;
}

function buildMdPointerText(doc, storePosix, runbook, batchKind) {
  return [
    MD_POINTER_LEADS[batchKind] || MD_POINTER_LEADS.comments,
    doc,
    '',
    threadsAddressLine(storePosix, runbook),
  ].join('\n');
}

// Arm the stall watch for an md send: covered = every open thread in the
// merged view (the pointer says "the open threads", so one send covers them
// all). Best-effort — a failed read just means no reminder for this send.
async function armMdStallWatch(p, doc, storePosix, runbook) {
  try {
    const { merged } = await mergedCommentStore(p);
    armStallWatch(p, {
      coveredIds: merged.threads.filter((t) => (t.status || 'open') === 'open').map((t) => t.id),
      remindText: `Reminder: open threads on ${doc} remain unaddressed.\n`
        + threadsAddressLine(storePosix, runbook),
    });
  } catch {}
}

function pasteMdPointer(doc, storePosix, runbook, batchKind, { toPrompt = false } = {}) {
  return pasteAgentPing(buildMdPointerText(doc, storePosix, runbook, batchKind), { toPrompt });
}

// One user send-batch of md comments: tick the store's turn clock, append one
// open thread per comment, then paste the pointer.
ipcMain.handle('md-add-threads', async (event, { docPath, threads, batchKind, allowMissingRunbook, toPrompt = false } = {}) => {
  const doc = String(docPath || '');
  if (!doc.startsWith('/') || !isMarkdownFilePath(doc)) {
    return { success: false, error: 'Not a markdown document path' };
  }
  const items = (Array.isArray(threads) ? threads : [])
    .map((t) => ({
      body: String((t && t.body) || '').trim(),
      // Optional rider on an edit thread: the user's note about the edit,
      // appended as a second message so the envelope stays pure diff.
      note: String((t && t.note) || '').trim(),
      anchor: (t && t.anchor) || {},
    }))
    .filter((t) => t.body);
  if (!items.length) return { success: false, error: 'Empty comment batch' };
  const runbook = await resolveMdRunbook(doc);
  if (!runbook && !allowMissingRunbook) {
    return { success: false, error: runbookMissingError(MD_THREADS_RUNBOOK, 'document') };
  }
  const storePosix = mdStorePosixPath(doc);
  const p = await fsPathFromPosix(storePosix);
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      store.turn = (Number.isFinite(store.turn) ? store.turn : 0) + 1;
      for (const item of items) {
        store.threads.push({
          id: newThreadId(),
          title: '',
          anchor: {
            snippet: item.anchor.snippet || '',
            context: item.anchor.context || '',
            wholeBlock: !!item.anchor.wholeBlock,
            heading: item.anchor.heading || '',
            // Image comments anchor by the image's authored src (snippet holds
            // its alt); present only for those, absent for text anchors.
            ...(item.anchor.src ? { src: String(item.anchor.src) } : {}),
          },
          // No `status` field — same rule as the review store: main only ever
          // wrote 'open', readers default absent to open, the merge derives
          // the rest from journal events and message recency.
          anchor_status: 'ok',
          messages: [
            { author: 'user', body: item.body, ts: Date.now(), turn: store.turn },
            ...(item.note ? [{ author: 'user', body: item.note, ts: Date.now(), turn: store.turn }] : []),
          ],
        });
      }
      await saveCommentStore(p, store);
      if (!pasteMdPointer(doc, storePosix, runbook, batchKind, { toPrompt })) {
        return { success: false, error: 'No active terminal process' };
      }
      if (!toPrompt) await armMdStallWatch(p, doc, storePosix, runbook);
      return { success: true, data: mergeStoreWithJournal(store, await readJournalEvents(p)) };
    } catch (e) { return { success: false, error: e.message }; }
  });
});

// Write the (edited) markdown document itself — the handoff's single write.
// Same atomic tmp+rename discipline as the store, same UNC translation.
ipcMain.handle('md-write-file', async (event, { docPath, content } = {}) => {
  const doc = String(docPath || '');
  if (!doc.startsWith('/') || !isMarkdownFilePath(doc)) {
    return { success: false, error: 'Not a markdown document path' };
  }
  try {
    const p = await fsPathFromPosix(doc);
    await fs.promises.writeFile(p + '.tmp', String(content == null ? '' : content), 'utf8');
    await fs.promises.rename(p + '.tmp', p);
    const st = await fs.promises.stat(p);
    return { success: true, path: doc, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) { return { success: false, error: e.message }; }
});

// Read the sidecar store for the viewer's thread layer. Missing store = no
// threads yet, not an error (mirrors read-review-comments).
ipcMain.handle('md-read-threads', async (event, { docPath } = {}) => {
  const doc = String(docPath || '');
  if (!doc.startsWith('/') || !isMarkdownFilePath(doc)) {
    return { success: false, error: 'Not a markdown document path' };
  }
  try {
    const p = await fsPathFromPosix(mdStorePosixPath(doc));
    // Merged view: store + agent journal — what every thread renderer reads.
    const { merged } = await mergedCommentStore(p);
    return { success: true, data: merged };
  } catch (e) { return { success: false, error: e.message }; }
});

// A follow-up on an existing thread. Same send semantics as a new batch —
// Enter always sends in the md grammar — so it reopens the thread, ticks the
// turn clock, and pastes the pointer.
ipcMain.handle('md-add-message', async (event, { docPath, threadId, body, allowMissingRunbook, toPrompt = false } = {}) => {
  const doc = String(docPath || '');
  if (!doc.startsWith('/') || !isMarkdownFilePath(doc)) {
    return { success: false, error: 'Not a markdown document path' };
  }
  const text = String(body == null ? '' : body).trim();
  if (!text) return { success: false, error: 'Empty comment' };
  const runbook = await resolveMdRunbook(doc);
  if (!runbook && !allowMissingRunbook) {
    return { success: false, error: runbookMissingError(MD_THREADS_RUNBOOK, 'document') };
  }
  const storePosix = mdStorePosixPath(doc);
  const p = await fsPathFromPosix(storePosix);
  return withCommentsLock(p, async () => {
    try {
      const store = await loadCommentStore(p);
      const t = store.threads.find((x) => x.id === threadId);
      if (!t) return { success: false, error: 'Thread not found' };
      store.turn = (Number.isFinite(store.turn) ? store.turn : 0) + 1;
      if (!Array.isArray(t.messages)) t.messages = [];
      // The reopen is derived, never written: this follow-up postdates any
      // journal `resolved`, so the merge's recency rule reopens the thread.
      t.messages.push({ author: 'user', body: text, ts: Date.now(), turn: store.turn });
      await saveCommentStore(p, store);
      if (!pasteMdPointer(doc, storePosix, runbook, undefined, { toPrompt })) {
        return { success: false, error: 'No active terminal process' };
      }
      if (!toPrompt) await armMdStallWatch(p, doc, storePosix, runbook);
      return { success: true, data: mergeStoreWithJournal(store, await readJournalEvents(p)) };
    } catch (e) { return { success: false, error: e.message }; }
  });
});


// The webview overlay (review comments) loads from a preload that talks to main
// directly. The renderer fetches this file:// URL and sets it as the <webview>
// preload attribute. We load the BUNDLED copy (dist/) so the preload can share
// modules (comment-ui) inlined by esbuild across the host/guest boundary — raw
// src can't require shared files in the sandboxed guest. Works from the asar.
ipcMain.handle('get-webview-preload-url', () => {
  try { return require('url').pathToFileURL(path.join(__dirname, '..', 'dist', 'web-viewer-preload.js')).href; }
  catch { return null; }
});

// Alt-click support: resolve a clicked path with the full everywhere-sweep and
// hand every candidate back for the renderer's chooser. Resolve only, no open —
// the renderer routes the picked path to its normal destination (md viewer,
// web viewer, IDE for anchored clicks, OS open).
ipcMain.handle('resolve-path-choices', async (event, filePath) => {
  try {
    return await resolveClickedPath(filePath, { search: 'always' });
  } catch (e) {
    return null;
  }
});

// OS-open a clicked path: a folder opens in the native file explorer (Explorer
// on Windows, Finder on macOS), a file in its default app — shell.openPath
// handles both kinds. The platform work is all in the path: Windows Explorer
// needs the WSL path in \\wsl.localhost UNC form (wslpath -w), Finder takes
// the POSIX path as-is. An ambiguous relative path comes back as { choices }
// for the renderer's chooser instead of guessing.
ipcMain.handle('open-resource', async (event, filePath) => {
  try {
    const resolved = await resolveClickedPath(filePath);
    if (!resolved) return { success: false, error: 'File not found' };
    if (resolved.choices) return { success: false, choices: resolved.choices };
    const target = process.platform === 'win32'
      ? await wslExec(['wslpath', '-w', resolved.path])
      : resolved.path;
    const err = await shell.openPath(target);
    return err ? { success: false, error: err } : { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Embedded web viewer: corporate-auth diagnostics ---
// The renderer hosts remote pages in a <webview>. These app-level handlers
// surface whether corporate auth completes inside the embed, where the moving
// parts are SSO, TLS interception, and client certificates. They only log; they
// never weaken trust (a certificate-error is reported, never bypassed).
app.on('select-client-certificate', (event, webContents, url, list, callback) => {
  log(`[webview/client-cert] ${url} requested a client certificate; ${list.length} available`);
  list.forEach((c, i) => log(`[webview/client-cert]   [${i}] subject="${c.subjectName}" issuer="${c.issuerName}"`));
  if (list.length > 0) {
    event.preventDefault();
    log('[webview/client-cert] auto-selecting [0] to let the handshake proceed');
    callback(list[0]);
  }
});

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  log(`[webview/tls-error] ${url} :: ${error} (issuer="${certificate && certificate.issuerName}")`);
  callback(false); // never bypass — a TLS failure must stay visible
});

app.on('login', (event, webContents, request, authInfo) => {
  log(`[webview/login] auth challenge isProxy=${authInfo.isProxy} scheme=${authInfo.scheme} host=${authInfo.host}`);
});

// Some servers content-negotiate their index document to `application/xhtml+xml`
// for clients that advertise it in Accept. Chromium then parses HTML with its XML
// parser — but the markup is HTML, not well-formed XHTML (`<body unresolved>`,
// unclosed `<meta>`/`<link>`, unescaped `&`), so the parse bails at the first error
// and renders "the page up to the first error": the head's inline <style>/<script>
// dumped as raw source on a white page. It renders fine at first (a normal top-level
// navigation ranks text/html first) and breaks only when a later reload advertises
// xhtml first. Force document responses in the viewer partition back to text/html so
// they parse as HTML. Scoped to application/xhtml+xml on document loads, so real
// image/svg+xml / text/xml / RSS a user clicks through are left untouched. The
// partition string must match the one web-viewer.js sets on the <webview>.
// Runs from whenReady — session.fromPartition needs the app ready.
function normalizeViewerContentType() {
  const viewerSession = session.fromPartition('persist:webviewer');
  // Request side: stop advertising application/xhtml+xml on document loads, so the
  // server never negotiates it in the first place. The response-side rewrite below
  // only sees network responses — the HTTP cache stores the ORIGIN's headers, and a
  // later cache hit / 304 revalidation (whose response carries no Content-Type)
  // resurfaces the original application/xhtml+xml, XML-parsing the page into raw
  // source. Killing the advertisement keeps a poisoned entry from ever being written.
  viewerSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const isDoc = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    const headers = details.requestHeaders || {};
    if (isDoc) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() !== 'accept') continue;
        const v = headers[name];
        if (typeof v === 'string' && /application\/xhtml\+xml/i.test(v)) {
          headers[name] = v.split(',')
            .filter((part) => !/^\s*application\/xhtml\+xml\b/i.test(part))
            .join(',');
        }
      }
    }
    callback({ requestHeaders: headers });
  });
  viewerSession.webRequest.onHeadersReceived((details, callback) => {
    const isDoc = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    const headers = details.responseHeaders || {};
    if (isDoc) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() !== 'content-type') continue;
        const vals = headers[name];
        if (Array.isArray(vals) && vals.some((v) => /application\/xhtml\+xml/i.test(v))) {
          headers[name] = vals.map((v) => v.replace(/application\/xhtml\+xml/i, 'text/html'));
          log(`[webview/content-type] rewrote application/xhtml+xml → text/html for ${details.url}`);
        }
      }
    }
    callback({ responseHeaders: headers });
  });
}

app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;
  // A link asking for a new window (target=_blank, window.open) used to get a bare
  // BrowserWindow: our icon and title, no address bar, no back button — a remote page
  // wearing the app's face. A login form there is one nobody can verify, which is
  // reason enough on its own. Popups go to the system browser instead, where the URL
  // is visible and the password manager works. A second band isn't the alternative:
  // the viewer shows one page at a time by design, and the popup's opener is usually
  // an auth flow that wants a real browser anyway.
  contents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url, 'viewer popup');
    return { action: 'deny' };
  });
  // Forcing nativeTheme dark (for the terminal UI) also makes embedded pages
  // report prefers-color-scheme: dark. Emulate the real OS preference on the
  // guest so pages look like a normal browser — without lightening the terminal.
  try {
    contents.debugger.attach('1.3');
    const applyScheme = () => {
      contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: guestColorScheme }],
      }).catch(() => {});
    };
    applyScheme();
    contents.on('dom-ready', applyScheme);
  } catch (e) {
    log('[webview] color-scheme emulation unavailable: ' + (e && e.message));
  }
  contents.on('did-navigate', (e, url, code, status) => log(`[webview/nav] ${url} (${code} ${status})`));
  contents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log(`[webview/nav] FAIL ${code} ${desc} ${url}`);
  });
});

app.whenReady().then(async () => {
  // Read the OS preference while themeSource is still 'system', then force dark.
  guestColorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  nativeTheme.themeSource = 'dark';
  // Keep the embedded viewer parsing guest pages as HTML, never XHTML.
  try { normalizeViewerContentType(); } catch (e) { log('[webview] content-type normalization unavailable: ' + (e && e.message)); }
  // No application menu — the menu line is gone. Session management happens
  // from a fresh Agent Term's startup picker so an active PTY is not reused
  // accidentally.
  // Standard Edit accelerators (Copy/Paste/etc.) on the terminal are handled
  // by src/terminal-keyboard.js, so removing the menu doesn't break them.
  Menu.setApplicationMenu(null);

  if (!app.isPackaged) {
    try {
      requireSourceStartCwd();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log('[dev] invalid source launch: ' + message);
      dialog.showErrorBox('AgentTerm source launch failed', message);
      app.quit();
      return;
    }
  }

  // Sweep stale active-window registry entries (dead pids / past boots) and
  // compact the events log so the picker stays fast over months of history.
  try {
    const userDataDir = app.getPath('userData');
    sessionsLog.gcActiveFiles(userDataDir);
    sessionsLog.compactSessionsLog(userDataDir);
  } catch (err) {
    console.warn('[main] sessions-log startup init failed:', err && err.message);
  }

  // Dev: rebuild every generated runtime bundle on every startup. This covers
  // both the host renderer and the sandboxed web-viewer preload; main/preload
  // modules load directly from src. Old outputs are removed first, and any
  // failure aborts before createWindow, so no launch or relaunch can execute a
  // stale artifact. Packaged apps ship the bundles produced by the same helper.
  if (!app.isPackaged) {
    try {
      rebuildRuntimeBundles({
        esbuild: require('esbuild'),
        fs,
        srcDir: __dirname,
        distDir: path.join(__dirname, '..', 'dist'),
      });
      log('[dev] rebuilt every runtime bundle on startup');
    } catch (err) {
      log('[dev] runtime bundle rebuild FAILED:\n' + (err && err.message));
      log('[dev] aborting startup; stale runtime bundles are never used.');
      app.quit();
      return;
    }
  }

  createWindow();

  // Debug shortcut for pixel-picking DWM's fallback/transition surface.
  // Toggles forceFallbackForScreenshot — when ON, both iconic hooks return
  // without pushing a bitmap, so DWM displays its generic preview surface
  // on the taskbar popup and Aero Peek. We also invalidate DWM's cached
  // thumbnail so the next hover triggers a fresh request (and gets the
  // skip). Toggle OFF restores normal card rendering; we explicitly
  // re-render so DWM gets a fresh bitmap rather than serving its
  // generic surface from cache.
  try {
    const accel = 'CommandOrControl+Shift+F11';
    const ok = globalShortcut.register(accel, () => {
      forceFallbackForScreenshot = !forceFallbackForScreenshot;
      log('[force-fallback] toggled ' + (forceFallbackForScreenshot ? 'ON' : 'OFF'));
      try {
        if (cachedHwnd && typeof dwm.invalidate === 'function') {
          dwm.invalidate(cachedHwnd);
        }
      } catch (err) {
        log('[force-fallback] invalidate failed: ' + (err && err.message));
      }
      if (!forceFallbackForScreenshot) {
        // Force a re-render so the next hover gets a fresh card instead
        // of the generic surface.
        try { lastPushedPayloadHash = null; } catch {}
        try { renderAndPushIconicBitmaps(); } catch (err) {
          log('[force-fallback] re-render failed: ' + (err && err.message));
        }
      }
    });
    if (!ok) {
      log('[force-fallback] failed to register ' + accel);
    } else {
      log('[force-fallback] shortcut registered: ' + accel + ' (toggles DWM fallback surface for screenshot)');
    }
  } catch (err) {
    log('[force-fallback] shortcut registration error: ' + (err && err.message));
  }
});

// Quitting with a live shell is what turns an exit into a crash on macOS.
// node-pty reports child exit from a waiter thread through a threadsafe
// function; if that lands while Node is already freeing the environment, N-API
// cannot enter JS to deliver it and rethrows as C++, which terminates the
// process. The crash report is unambiguous — uv_run beneath
// node::FreeEnvironment, ThrowAsJavaScriptException above it — and no JS-side
// guard can help, because the call never reaches JS.
//
// So the shell has to be gone BEFORE the quit proceeds rather than killed
// alongside it: hold the quit, kill, let the exit callback land on a healthy
// loop, then quit for real. A shell exits on the signal in milliseconds; the
// timer is only there so one that ignores it cannot hang the app.
const PTY_QUIT_DRAIN_MS = 1000;
let ptyQuitDrain = null;

function finishQuitAfterPty() {
  if (ptyQuitDrain) { clearTimeout(ptyQuitDrain); ptyQuitDrain = null; }
  ptyProcess = null; // lets the next before-quit through
  app.quit();
}

app.on('before-quit', (event) => {
  if (!ptyProcess || ptyQuitDrain) return; // nothing live, or already draining
  event.preventDefault();
  const p = ptyProcess;
  ptyQuitDrain = setTimeout(finishQuitAfterPty, PTY_QUIT_DRAIN_MS);
  try { p.onExit(finishQuitAfterPty); } catch {}
  try { p.kill(); }
  catch (err) {
    log('[main] PTY kill during quit failed: ' + (err && err.message));
    finishQuitAfterPty();
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('window-all-closed', () => {
  if (userClosed && shouldAutoRelaunchAfterUserClose()) {
    relaunchLatestAndExit();
    return;
  }
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
