// Visual preview for the custom chrome bar (the titleBarOverlay content
// in src/chrome-bar.js). Renders the bar at every relevant session state,
// stacks them vertically with state labels, and screenshots the page to
// icon-preview/chrome-bar.png.
//
// Production parity: the page imports BAR_CSS and renderBarMarkup directly
// from src/chrome-bar.js, so the preview can't drift from what ships.
//
// Run: npx electron scripts/preview-chrome-bar.js

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { BAR_CSS, renderBarMarkup, hueColor, BAR_HEIGHT_PX } = require('../src/chrome-bar');
const { iconRenderScript, letterCandidates } = require('../src/icon-render');

// Each scenario is a snapshot of {hue, cli, prompt, isWorking} that the
// chrome bar might receive on a real run. The label is shown next to the
// rendered bar for context.
const SCENARIOS = [
  {
    label: 'Pre-CLI / sessions picker (no cli, no prompt)',
    state: { hue: null, cli: null, prompt: null, isWorking: false },
  },
  {
    label: 'CLI booted, prompt not yet typed',
    state: { hue: 24, cli: 'claude', prompt: null, isWorking: true },
  },
  {
    label: 'Active session, AI working (claude, hue 72°)',
    state: { hue: 72, cli: 'claude', prompt: 'Migrate the database schema with backwards-compatible defaults', isWorking: true },
  },
  {
    label: 'Active session, AI idle (codex, hue 168°)',
    state: { hue: 168, cli: 'codex', prompt: 'Refactor the auth middleware to use the new policy engine', isWorking: false },
  },
  {
    label: 'Long prompt — should ellipsize at the available width',
    state: { hue: 240, cli: 'claude', prompt: 'Investigate the build timeout exceeded after 600s while waiting for the integration tests on the deploy worker pool, please diagnose root cause and propose a fix that does not touch the existing test orchestration', isWorking: true },
  },
  {
    label: 'Short prompt (gh copilot)',
    state: { hue: 312, cli: 'copilot', prompt: 'Add tests', isWorking: false },
  },
  {
    label: 'Cursor session (cli=agent)',
    state: { hue: 216, cli: 'agent', prompt: 'Wire the websocket reconnect logic into the new dispatcher', isWorking: true },
  },
];

// In production, titleBarOverlay reserves space at the top of the window
// for the OS caption buttons, and the chrome bar fills env(titlebar-area-width)
// — i.e., the window width minus that reserved chrome. To match the live
// look in the preview, we reserve the same ~140px on the right of each row
// (an empty placeholder where Windows would draw min/max/close).
const WINDOW_WIDTH = 1100;
const CAPTION_BUTTONS_WIDTH = 140;
const BAR_AREA_WIDTH = WINDOW_WIDTH - CAPTION_BUTTONS_WIDTH;
const LABEL_HEIGHT = 24;
const ROW_GAP = 18;

function buildPreviewHTML(chipNsByScenario) {
  const rows = SCENARIOS.map((sc, i) => {
    const chipN = chipNsByScenario[i];
    // Mirror what production's update() does: set --at-hue on a
    // container that's an ancestor of both .at-chrome and the
    // .at-chrome-hue-divider so both pick it up via inheritance. In
    // production that's :root; in the preview we use .row-bar.
    const color = hueColor(sc.state.hue);
    const hueStyle = color ? ` style="--at-hue: ${color}"` : '';
    return `
    <div class="row">
      <div class="row-label">${escapeHtml(sc.label)}</div>
      <div class="row-bar"${hueStyle}>
        <div class="at-chrome">${renderBarMarkup(sc.state, chipN)}</div>
        <div class="caption-stub" title="reserved for system min/max/close in production">_  ▢  ✕</div>
        <div class="at-chrome-hue-divider"></div>
      </div>
    </div>
  `;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>chrome-bar preview</title>
  <style>
    html, body {
      margin: 0; padding: 0;
      background: #0b1220;
      color: #cbd5e1;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    body { padding: 24px; }
    .row { margin-bottom: ${ROW_GAP}px; }
    .row-label {
      font-size: 13px;
      color: #9aa3b2;
      margin-bottom: 6px;
    }
    .row-bar {
      position: relative;
      width: ${WINDOW_WIDTH}px;
      height: ${BAR_HEIGHT_PX + 1}px;            /* chrome bar + 1px hue divider */
      background: #0c0c0c;
      border: 1px solid #1c1c1c;
      box-sizing: content-box;
      overflow: hidden;
    }
    /* The chrome bar normally uses position:fixed and CSS env(titlebar-area-*)
       to size itself. In the preview we override those — pin it inside the
       row container at the bar-area width (so the caption stub on the right
       represents the OS-reserved region). */
    .at-chrome {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: ${BAR_AREA_WIDTH}px !important;
      height: ${BAR_HEIGHT_PX}px !important;
    }
    .caption-stub {
      position: absolute;
      top: 0;
      right: 0;
      width: ${CAPTION_BUTTONS_WIDTH}px;
      height: ${BAR_HEIGHT_PX}px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
      font: 18px "Segoe UI", system-ui, sans-serif;
      color: #707070;
      letter-spacing: 4px;
      background: #0c0c0c;
      border-left: 1px solid #1c1c1c;
    }
    /* The production hue divider is position:fixed under
       env(titlebar-area-height). In the preview we pin it absolutely
       inside the row-bar so it spans the FULL row width (across both the
       chrome-bar area and the caption-stub area). */
    .at-chrome-hue-divider {
      position: absolute !important;
      top: ${BAR_HEIGHT_PX}px !important;
      left: 0 !important;
      right: 0 !important;
      width: ${WINDOW_WIDTH}px !important;
    }
    /* Inject the production CSS so the bar styles match exactly. */
    ${BAR_CSS}
  </style>
</head>
<body>
  ${rows}
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const totalRowH = LABEL_HEIGHT + BAR_HEIGHT_PX + ROW_GAP + 8;
  const winHeight = SCENARIOS.length * totalRowH + 64;

  const win = new BrowserWindow({
    show: false,
    width: WINDOW_WIDTH + 64,
    height: winHeight,
    backgroundColor: '#0b1220',
  });

  // First pass — probe iconRenderScript for each scenario's chosen letter
  // count `n`. The chip is rendered INLINE on the chrome bar (same font
  // as title, hue underline only), so we don't need the canvas PNG; we
  // do need to know whether the taskbar picked n=3 or n=4 for this
  // letter set, so the chrome bar splits the prompt at the same index.
  await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
  const chipNsByScenario = [];
  for (const sc of SCENARIOS) {
    const { hue, prompt } = sc.state;
    if (typeof hue !== 'number') {
      chipNsByScenario.push(null);
      continue;
    }
    const candidates = letterCandidates(prompt || '');
    const script = iconRenderScript(hue, candidates);
    const raw = await win.webContents.executeJavaScript(script);
    try {
      const parsed = JSON.parse(raw);
      chipNsByScenario.push(parsed && parsed.n ? parsed.n : 3);
    } catch {
      chipNsByScenario.push(3);
    }
  }

  const html = buildPreviewHTML(chipNsByScenario);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // Give layout a frame to settle.
  await new Promise(r => setTimeout(r, 200));

  const image = await win.webContents.capturePage();
  const file = path.join(outDir, 'chrome-bar.png');
  fs.writeFileSync(file, image.toPNG());
  console.log('wrote ' + file);

  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
