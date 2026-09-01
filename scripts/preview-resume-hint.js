// Visual preview for the resume-hint overlay (src/resume-hint.js).
//
// Renders the hint in each state (pre-Enter / post-Enter / intercept-off)
// and title shape (short / long / empty / with special chars), composited
// into icon-preview/resume-hint.png.
// The composite includes a mock chrome-bar above each hint to show how
// they stack in production.

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { BAR_CSS, BAR_HEIGHT_PX, renderBarMarkup, hueColor } = require('../src/chrome-bar');
const { HINT_CSS, HINT_HEIGHT_PX, renderHintMarkup } = require('../src/resume-hint');

const SCENARIOS = [
  {
    name: 'pre-enter-short',
    label: 'Pre-Enter state — short title',
    title: 'Auth flow review',
    postEnter: false,
    chrome: { hue: 0, cli: 'claude', prompt: 'Migrate the database schema with backwards-compatible defaults', isWorking: true },
  },
  {
    name: 'pre-enter-medium',
    label: 'Pre-Enter state — typical AI-CLI title',
    title: 'Refactoring auth middleware tests',
    postEnter: false,
    chrome: { hue: 72, cli: 'codex', prompt: 'Investigate the build timeout in CI', isWorking: false },
  },
  {
    name: 'post-enter-after-first-keystroke',
    label: 'Post-Enter state — user pressed Enter; intercept fired',
    title: 'Refactoring auth middleware tests',
    postEnter: true,
    chrome: { hue: 168, cli: 'codex', prompt: 'Investigate the build timeout in CI', isWorking: true },
  },
  {
    name: 'post-enter-collapsed',
    label: 'Collapsed — after the 2nd Enter (the pick) the band recedes to a strip; hover re-opens it',
    title: 'Refactoring auth middleware tests',
    postEnter: true,
    collapsed: true,
    chrome: { hue: 168, cli: 'codex', prompt: 'Investigate the build timeout in CI', isWorking: false },
  },
  {
    name: 'intercept-off',
    label: 'Intercept-off state — non-Enter input (startup dialog) cancelled the shortcut',
    title: 'Refactoring auth middleware tests',
    interceptOff: true,
    chrome: { hue: 120, cli: 'claude', prompt: 'Investigate the build timeout in CI', isWorking: false },
  },
  {
    name: 'long-title-ellipsizes',
    label: 'Long title — ellipsizes at available width',
    title: 'Investigating the build timeout exceeded after 600s while waiting for the integration tests on the deploy worker pool, please diagnose root cause',
    postEnter: false,
    chrome: { hue: 240, cli: 'claude', prompt: 'Investigate the build timeout', isWorking: true },
  },
  {
    name: 'title-missing-fallback',
    label: 'Title null — falls back to the prompt above',
    title: null,
    postEnter: false,
    chrome: { hue: 216, cli: 'agent', prompt: 'Wire the websocket reconnect logic into the new dispatcher', isWorking: false },
  },
  {
    name: 'special-chars',
    label: 'Title with quotes / ampersand — HTML-escaped correctly',
    title: 'Reading "deploy-worker" logs & manifest',
    postEnter: false,
    chrome: { hue: 312, cli: 'copilot', prompt: 'Add tests for "settings" module', isWorking: true },
  },
];

const WINDOW_WIDTH = 1100;
const CAPTION_BUTTONS_WIDTH = 140;
const BAR_AREA_WIDTH = WINDOW_WIDTH - CAPTION_BUTTONS_WIDTH;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function buildPreviewHTML(chipNsByScenario) {
  const rows = SCENARIOS.map((sc, i) => {
    const chipN = chipNsByScenario[i];
    const color = hueColor(sc.chrome.hue);
    const hueStyle = color ? ` style="--at-hue: ${color}"` : '';
    return `
    <div class="row">
      <div class="row-label">${escapeHtml(sc.label)}</div>
      <div class="row-stack"${hueStyle}>
        <div class="at-chrome">${renderBarMarkup(sc.chrome, chipN)}</div>
        <div class="caption-stub" title="reserved for system min/max/close in production">_  ▢  ✕</div>
        <div class="at-chrome-hue-divider"></div>
        <div class="at-resume-hint${sc.postEnter ? ' post-enter' : ''}${sc.interceptOff ? ' intercept-off' : ''}${sc.collapsed ? ' collapsed' : ''}">${renderHintMarkup({ prompt: sc.chrome.prompt, title: sc.title })}</div>
      </div>
    </div>
  `;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>resume-hint preview</title>
  <style>
    html, body { margin: 0; padding: 0; background: #0b1220; color: #cbd5e1;
                 font-family: "Segoe UI", system-ui, sans-serif; }
    body { padding: 24px; }
    .row { margin-bottom: 28px; }
    .row-label { font-size: 13px; color: #9aa3b2; margin-bottom: 6px; }
    .row-stack {
      position: relative;
      width: ${WINDOW_WIDTH}px;
      height: ${BAR_HEIGHT_PX + 1 + HINT_HEIGHT_PX}px;
      background: #0c0c0c;
      border: 1px solid #1c1c1c;
      box-sizing: content-box;
      overflow: hidden;
    }
    /* Same overrides as preview-chrome-bar so the chrome lays out cleanly. */
    .at-chrome {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: ${BAR_AREA_WIDTH}px !important;
      height: ${BAR_HEIGHT_PX}px !important;
    }
    .caption-stub {
      position: absolute;
      top: 0; right: 0;
      width: ${CAPTION_BUTTONS_WIDTH}px;
      height: ${BAR_HEIGHT_PX}px;
      display: flex; align-items: center; justify-content: center; gap: 18px;
      font: 18px "Segoe UI", system-ui, sans-serif;
      color: #707070; letter-spacing: 4px;
      background: #0c0c0c;
      border-left: 1px solid #1c1c1c;
    }
    .at-chrome-hue-divider {
      position: absolute !important;
      top: ${BAR_HEIGHT_PX}px !important;
      left: 0 !important; right: 0 !important;
      width: ${WINDOW_WIDTH}px !important;
    }
    /* Resume hint also needs to be pinned inside the row-stack rather than
       using its production env(titlebar-area-height) anchor. */
    .at-resume-hint {
      position: absolute !important;
      top: ${BAR_HEIGHT_PX + 1}px !important;
      left: 0 !important;
      right: 0 !important;
      width: ${WINDOW_WIDTH}px !important;
    }
    /* Production CSS for the chrome bar + hint, inlined verbatim. */
    ${BAR_CSS}
    ${HINT_CSS}
  </style>
</head>
<body>
  ${rows}
</body>
</html>`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: WINDOW_WIDTH + 64,
    height: SCENARIOS.length * (BAR_HEIGHT_PX + 1 + HINT_HEIGHT_PX + 50) + 64,
    backgroundColor: '#0b1220',
  });

  // First pass: probe iconRenderScript for each scenario's chip letter count
  // so the chrome bar's chip-letter-underline matches the taskbar version.
  const { iconRenderScript, letterCandidates } = require('../src/icon-render');
  await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
  const chipNs = [];
  for (const sc of SCENARIOS) {
    const { hue, prompt } = sc.chrome;
    if (typeof hue !== 'number') { chipNs.push(null); continue; }
    const candidates = letterCandidates(prompt || '');
    const script = iconRenderScript(hue, candidates);
    const raw = await win.webContents.executeJavaScript(script);
    try {
      const parsed = JSON.parse(raw);
      chipNs.push(parsed && parsed.n ? parsed.n : 3);
    } catch {
      chipNs.push(3);
    }
  }

  const html = buildPreviewHTML(chipNs);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // Let the band's slide-in finish before capturing.
  await new Promise(r => setTimeout(r, 900));

  const image = await win.webContents.capturePage();
  const file = path.join(outDir, 'resume-hint.png');
  fs.writeFileSync(file, image.toPNG());
  console.log('wrote ' + file);

  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
