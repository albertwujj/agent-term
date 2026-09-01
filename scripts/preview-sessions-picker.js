// Visual preview for the sessions picker (src/sessions-picker.js).
//
// Renders the picker across several states (empty filter, filter with
// matches, filter with no matches, CLI-prefix detection, hidden-active row)
// in a single Electron window, screenshots each, then composites them into
// a vertical stack saved at icon-preview/sessions-picker.png.
//
// Production parity: this loads sessions-picker.js directly via require()
// in a renderer with nodeIntegration enabled (preview-only). What you see
// is exactly what ships.

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const NOW = Date.now();

// Sample sessions covering the cases the picker has to handle:
//   · multiple past sessions, sorted by lastEventAt
//   · an active visible session  (disabled row)
//   · an active hidden session   ("hidden — bring forward" badge)
//   · a session with title === cli  (title line should be suppressed)
//   · a session with no title       (title line should be suppressed)
//   · prompts that share the search term so highlights are visible
// `prompt` here is the FIRST captured prompt (identity); `lastPrompt` is
// the most recent. Setting `lastPrompt === prompt` (or omitting it)
// collapses the row to a single-line.
const SAMPLE_SESSIONS = [
  // All three lines present (first / last / title all distinct):
  { id: 1, hue: 0,   cli: 'claude',  isActive: true,  isHidden: false,
    prompt:     'Migrate the database schema with backwards-compatible defaults',
    lastPrompt: 'Fix the lint warning on line 47 of migrations.go',
    title:      'Refactoring auth middleware tests',
    lastEventAt: NOW - 10 * 60 * 1000 },
  // Hidden active, all three distinct:
  { id: 2, hue: 72,  cli: 'codex',   isActive: true,  isHidden: true,
    prompt:     'Investigate the build timeout in CI',
    lastPrompt: 'Try increasing the worker pool size',
    title:      'Reading deploy worker logs',
    lastEventAt: NOW - 30 * 60 * 1000 },
  // First and last distinct, title duplicates last (suppressed):
  { id: 3, hue: 168, cli: 'claude',  isActive: false,
    prompt:     'Add tests for the rate-limit middleware',
    lastPrompt: 'Writing integration tests',
    title:      'Writing integration tests',
    lastEventAt: NOW - 2 * 60 * 60 * 1000 },
  // Cursor / agent — first and last identical (collapses last line):
  { id: 4, hue: 216, cli: 'agent',   isActive: false,
    prompt:     'Wire the websocket reconnect logic into the new dispatcher',
    lastPrompt: 'Wire the websocket reconnect logic into the new dispatcher',
    title:      'Inspecting reconnect state machine',
    lastEventAt: NOW - 3 * 60 * 60 * 1000 },
  // Title equals cli (suppressed):
  { id: 5, hue: 240, cli: 'codex',   isActive: false,
    prompt:     'Design the new policy engine API',
    lastPrompt: 'Sketch the rule-evaluation cache',
    title:      'codex',
    lastEventAt: NOW - 4 * 60 * 60 * 1000 },
  // No title (suppressed), no follow-up (collapses to one line):
  { id: 6, hue: 312, cli: 'claude',  isActive: false,
    prompt:     'Click handler refactor for the settings page',
    lastPrompt: null,
    title:      null,
    lastEventAt: NOW - 8 * 60 * 60 * 1000 },
  // Drifted titles — title is the name the CLI first gave the conversation,
  // lastTitle is what the window most recently ran. Picker shows both italic lines:
  //   "Backfill migration"
  //   ↳ "Investigating worker timeouts"
  // Bumped to the most-recent slot so it's the first past-session row
  // visible in the empty-filter preview screenshot.
  { id: 7, hue: 24,  cli: 'claude',  isActive: false,
    prompt:       'Backfill the user_email column with batch size 1000',
    lastPrompt:   'Pause backfill, the workers are timing out at the deploy gateway',
    title:        'Backfill migration',
    lastTitle:    'Investigating worker timeouts',
    lastEventAt: NOW - 5 * 60 * 1000 },
  // lastTitle === title (no drift) — picker collapses to a single italic line:
  { id: 8, hue: 96,  cli: 'codex',   isActive: false,
    prompt:       'Fix the auth token refresh race condition',
    lastPrompt:   'Add a regression test for the double-refresh path',
    title:        'Auth flow review',
    lastTitle:    'Auth flow review',
    lastEventAt: NOW - 48 * 60 * 60 * 1000 },
  // First only — no later prompts, no title:
  { id: 9, hue: 192, cli: 'claude',  isActive: false,
    prompt:     'Investigate the flaky login test in the service layer',
    lastPrompt: 'Investigate the flaky login test in the service layer',
    title:      'Reading the auth spec',
    lastEventAt: NOW - 72 * 60 * 60 * 1000 },
];

const ACTIVE_IDS = SAMPLE_SESSIONS.filter(s => s.isActive).map(s => s.id);

// Each scenario produces one screenshot.
const SCENARIOS = [
  { name: 'empty-filter',
    label: 'Empty filter — default view (active visible + hidden + past)',
    filter: '' },
  { name: 'free-form-rate',
    label: 'Free-form search "rate" — matches Mig{rate} and {rate}-limit; counts in heading',
    filter: 'rate' },
  { name: 'cli-prefix-cl',
    label: 'CLI prefix "cl" — row 0 = "Start new claude"; past matches free-form (only "Click")',
    filter: 'cl' },
  { name: 'title-search-auth',
    label: 'Search "auth" — matches the OSC titles (now visible as dim subtitles)',
    filter: 'auth' },
  { name: 'no-matches',
    label: 'No matches — explicit empty-state row',
    filter: 'xyzzz' },
  { name: 'shell-fallthrough',
    label: 'Non-CLI text — row 0 falls back to "Run …"',
    filter: 'rgrep -n foo' },
];

// HTML page that hosts a single picker mount; we re-create it per scenario.
const PREVIEW_HTML = `<!DOCTYPE html>
<html>
<head>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; color: #ccc;
                  font-family: "Segoe UI", system-ui, sans-serif; }
  </style>
</head>
<body>
  <script>
    const { createPicker } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'sessions-picker'))});
    // Stub window.pty for the bring-forward IPC call from the picker.
    window.pty = { pickerBringForward: () => {} };
    let activePicker = null;
    window._mountPicker = function(sessions, activeIds, filter) {
      if (activePicker) { try { activePicker.destroy(); } catch {} activePicker = null; }
      activePicker = createPicker({
        sessions, activeIds,
        cwd: '/Users/dev/projects/agent-term',
        onPick: () => {}, onStartNew: () => {}, onClose: () => {},
      });
      // Drive the input programmatically so the filter logic + count + match
      // highlights all kick in. Dispatch the same 'input' event the picker
      // listens for in production.
      const input = document.querySelector('.at-picker-input');
      if (input) {
        input.value = filter || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();   // hide the caret in screenshots
      }
    };
  </script>
</body>
</html>`;

const WIDTH = 900;
const HEIGHT = 700;
const SHOTS_DIR = path.join(__dirname, '..', 'icon-preview');

app.whenReady().then(async () => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PREVIEW_HTML));

  // Render each scenario, screenshot, accumulate.
  const shots = [];
  for (const sc of SCENARIOS) {
    await win.webContents.executeJavaScript(
      `_mountPicker(${JSON.stringify(SAMPLE_SESSIONS)}, ${JSON.stringify(ACTIVE_IDS)}, ${JSON.stringify(sc.filter)})`,
    );
    // Let layout / fonts settle before snapping.
    await new Promise(r => setTimeout(r, 200));
    const image = await win.webContents.capturePage();
    shots.push({ scenario: sc, dataURL: image.toDataURL() });
  }

  // Composite all shots into a vertical stack via canvas. Canvas size is
  // unbounded — unlike BrowserWindow on macOS which clamps to screen height
  // and would truncate the composite if we tried to capturePage a tall window.
  const compositeWin = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: 600,
    backgroundColor: '#0b1220',
  });
  await compositeWin.loadURL('data:text/html;charset=utf-8,' +
    encodeURIComponent('<html><body style="background:#0b1220;margin:0;"></body></html>'));

  const compositeScript = `(async function() {
    const SHOTS = ${JSON.stringify(shots.map(s => ({
      name: s.scenario.name, label: s.scenario.label, filter: s.scenario.filter, dataURL: s.dataURL,
    })))};
    const PADX = 28, PADY = 28;
    const LABEL_H = 64;
    const SHOT_W = ${WIDTH};
    const SHOT_H = ${HEIGHT};
    const ROW_GAP = 24;
    const ROW_H = LABEL_H + SHOT_H;
    const W = SHOT_W + PADX * 2;
    const H = PADY * 2 + SHOTS.length * ROW_H + (SHOTS.length - 1) * ROW_GAP;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < SHOTS.length; i++) {
      const shot = SHOTS[i];
      const top = PADY + i * (ROW_H + ROW_GAP);

      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 16px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(shot.name, PADX, top);

      ctx.fillStyle = '#9aa3b2';
      ctx.font = '400 13px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(shot.label, PADX, top + 24);

      if (shot.filter) {
        ctx.fillStyle = '#7aa1d9';
        ctx.font = '400 13px Consolas, monospace';
        ctx.fillText('filter: "' + shot.filter + '"', PADX, top + 44);
      }

      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shot.dataURL; });
      ctx.drawImage(img, PADX, top + LABEL_H, SHOT_W, SHOT_H);
    }

    return canvas.toDataURL('image/png');
  })()`;

  const compositeDataURL = await compositeWin.webContents.executeJavaScript(compositeScript);
  const compositePNG = Buffer.from(compositeDataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
  const out = path.join(SHOTS_DIR, 'sessions-picker.png');
  fs.writeFileSync(out, compositePNG);
  console.log('wrote ' + out);

  shell.openPath(SHOTS_DIR);
  win.destroy();
  compositeWin.destroy();
  app.quit();
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
