// Visual preview for the icon + activity-timeline thumbnail.
//
// Renders:
//   icon-preview/icon-grid.png        — the production icon at multiple
//                                       letter sets (descender / no-descender /
//                                       narrow / wide / fallback) and at
//                                       both 24px taskbar size and 256px
//                                       full-canvas size, so we can verify:
//                                         · cap height fills most of the icon
//                                         · letters baseline-align with the
//                                           Windows taskbar button text mockup
//                                         · descenders (g, p, q, y) clear the
//                                           underline cleanly
//                                         · placeholder ("???") still fits
//
//   icon-preview/thumbnail-card.png   — the activity-timeline card at small
//                                       (280x158, real DWM thumbnail size)
//                                       and large (1280x720, Aero Peek size),
//                                       across scenarios:
//                                         · single prompt (just-started)
//                                         · multiple prompts (newest first)
//                                         · long pasted prompt that wraps/clips
//                                         · idle vs working state
//                                         · pre-prompt (title-only fallback)
//
// Run: npm run start -- preview-icon-thumb
//   (or directly:) electron scripts/preview-icon-and-thumbnail.js
//
// Production parity:
//   - The icon canvas script comes from ../src/icon-render — same file
//     main.js uses, so what you see here is exactly what ships.
//   - The thumbnail card comes from ../src/prompt-thumbnail (same module
//     wired into main.js's renderAndPushIconicBitmaps).

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const {
  iconRenderScript,
  firstLettersAndRest,
  letterCandidates,
} = require('../src/icon-render');
const promptThumbnail = require('../src/prompt-thumbnail');

const ICON_HUE_STEP = 24;

// ---- Sample prompts (drives both icon letter sets and thumbnail prompts). ----
//
// Picked to exercise: descenders ('g'), narrow caps ('I'), wide caps ('W'),
// punctuation-prefix (so the leading-letter skip kicks in), short prompts.
const ICON_SAMPLES = [
  { idx: 0, prompt: 'Migrate the database schema',           note: 'Mig — descender on g' },
  { idx: 1, prompt: 'Investigate the flaky login test',      note: 'Inv — no descender (packs larger)' },
  { idx: 2, prompt: 'Write the auth middleware tests',       note: 'Wri — wide W' },
  { idx: 3, prompt: 'Pay attention to the queue depth',      note: 'Pay — descender on y' },
  { idx: 4, prompt: 'Quickly check the deployment',          note: 'Qui — descender on Q' },
  { idx: 5, prompt: '"please fix the syntax issue"',         note: 'ple — leading-quote skipped' },
  { idx: 6, prompt: 'Up',                                    note: 'Up — short prompt, 2 letters' },
  { idx: 7, prompt: '',                                      note: '??? — placeholder (no prompt yet)' },
];

// ---- Thumbnail card scenarios. ----
const THUMB_SCENARIOS = [
  {
    name: 'single-prompt-just-started',
    cli: 'claude',
    ageLabel: 'Started just now',
    isWorking: true,
    prompts: [
      { prompt: 'Migrate the database schema to v2 with backwards-compatible defaults', t: Date.now() },
    ],
    hue: 0,
  },
  {
    name: 'multi-prompt-mixed-lengths',
    cli: 'claude',
    ageLabel: 'Started 2h 13m ago',
    isWorking: true,
    prompts: [
      { prompt: 'Migrate the database schema',  t: Date.now() - 60 * 60 * 1000 },
      { prompt: 'Add a backfill task for the user_email column with batch size 1000', t: Date.now() - 30 * 60 * 1000 },
      { prompt: 'Now write the integration tests for the migration',                t: Date.now() - 10 * 60 * 1000 },
      { prompt: 'Fix the lint error on line 47 of migrations.go',                   t: Date.now() - 60 * 1000 },
    ],
    hue: 72,
  },
  {
    name: 'long-paste-clips-cleanly',
    cli: 'codex',
    ageLabel: 'Started 18m ago',
    isWorking: false,
    prompts: [
      { prompt: 'Investigate the build', t: Date.now() - 15 * 60 * 1000 },
      { prompt: 'Here is the failing CI log: timeout exceeded after 600s while waiting for the integration tests on the deploy worker pool, please diagnose root cause and propose a fix that does not touch the existing test orchestration.', t: Date.now() - 1 * 60 * 1000 },
    ],
    hue: 168,
  },
  {
    name: 'idle-state',
    cli: 'claude',
    ageLabel: 'Started 4h ago',
    isWorking: false,
    prompts: [
      { prompt: 'Refactor the auth middleware to use the new policy engine', t: Date.now() - 3 * 60 * 60 * 1000 },
      { prompt: 'Add unit tests for the policy edge cases',                  t: Date.now() - 2 * 60 * 60 * 1000 },
    ],
    hue: 240,
  },
  {
    name: 'pre-prompt-title-only-fallback',
    cli: 'claude',
    ageLabel: 'Started 2m ago',
    isWorking: true,
    prompts: [
      // Until the first prompt is captured, main.js falls back to surfacing
      // the OSC title as a single "prompt" entry so the card isn't empty.
      { prompt: 'claude', t: Date.now() - 90 * 1000 },
    ],
    hue: 312,
  },
  {
    name: 'cursor-active-session',
    cli: 'agent',                          // agent === Cursor (CLI)
    ageLabel: 'Started 45m ago',
    isWorking: true,
    prompts: [
      { prompt: 'Wire the websocket reconnect logic into the new dispatcher', t: Date.now() - 5 * 60 * 1000 },
    ],
    hue: 216,
  },
];

// ---- Composite-render scripts. ----

// Builds a canvas script that lays out a vertical stack of (icon@256, icon@24
// inside a mock taskbar button, label) panels. Used for icon-grid.png.
function iconGridScript(samples) {
  const subscripts = samples.map(s => {
    const candidates = letterCandidates(s.prompt);
    const hue = (s.idx * ICON_HUE_STEP) % 360;
    return { ...s, hue, candidates, render: iconRenderScript(hue, candidates) };
  });
  return `(async function(){
    const samples = ${JSON.stringify(subscripts.map(s => ({
      idx: s.idx, prompt: s.prompt, hue: s.hue, candidates: s.candidates, note: s.note,
    })))};
    const ICON_BIG = 256;
    const ICON_SMALL = 24;
    const SCALE = 4;                          // upscale the small icon for legibility on the preview
    const PANEL_H = ICON_BIG + 60;
    const PANEL_W = 1100;
    const TASKBAR_H = 48;
    const TASKBAR_PAD = 12;
    const W = PANEL_W;
    const H = samples.length * PANEL_H + 20;

    const composite = document.createElement('canvas');
    composite.width = W;
    composite.height = H;
    const cctx = composite.getContext('2d');
    cctx.fillStyle = '#0b1220';
    cctx.fillRect(0, 0, W, H);

    // Each row: [256x256 icon] [mock 48px taskbar with the same icon @ 24px,
    // upscaled SCALEx + a sample button title to its right] [letter set + note]
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const top = 10 + i * PANEL_H;

      // Sub-render the production icon. The script returns JSON
      // { url, n } — n is the actual letter count the canvas chose to
      // draw at the target font (3 or 4).
      const iconScripts = ${JSON.stringify(subscripts.map(s => s.render))};
      const result = JSON.parse(eval(iconScripts[i]));
      const dataURL = result.url;
      const chosenN = result.n;
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataURL; });

      // Big icon — full canvas.
      cctx.drawImage(img, 20, top, ICON_BIG, ICON_BIG);

      // Mock taskbar button (slate-grey 48px row), with the icon @24px
      // upscaled SCALEx so we can actually see it at preview resolution.
      const tbX = 20 + ICON_BIG + 30;
      const tbY = top + (ICON_BIG - TASKBAR_H * SCALE) / 2;
      const tbW = 600;
      cctx.fillStyle = '#1c1c1c';
      cctx.fillRect(tbX, tbY, tbW, TASKBAR_H * SCALE);
      cctx.fillStyle = 'rgba(255,255,255,0.04)';
      cctx.fillRect(tbX, tbY, tbW, 1 * SCALE);

      // Upscaled icon at the left of the taskbar button.
      const iconRowY = tbY + (TASKBAR_H * SCALE - ICON_SMALL * SCALE) / 2;
      cctx.drawImage(img, tbX + TASKBAR_PAD * SCALE / 2, iconRowY, ICON_SMALL * SCALE, ICON_SMALL * SCALE);

      // Title text to the right of the icon — the "rest" of the prompt,
      // starting at index = (firstLetterIndex + chosenN). Matches what
      // the real app's mainWindow.setTitle() would show, given the canvas
      // picked chosenN letters for the icon.
      const titleX = tbX + TASKBAR_PAD * SCALE / 2 + ICON_SMALL * SCALE + 8 * SCALE;
      const titleY = tbY + TASKBAR_H * SCALE / 2;
      const titleFontPx = Math.round(12 * SCALE);
      cctx.fillStyle = '#e6e6e6';
      cctx.font = '400 ' + titleFontPx + 'px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
      cctx.textAlign = 'left';
      cctx.textBaseline = 'middle';
      let restText;
      if (s.prompt) {
        const firstLetter = s.prompt.search(/[A-Za-z]/);
        restText = firstLetter < 0 ? s.prompt : s.prompt.slice(firstLetter + chosenN);
      } else {
        restText = '(no prompt yet)';
      }
      cctx.fillText(restText, titleX, titleY);

      // Caption: chosen letter count + candidates considered + note.
      cctx.fillStyle = '#9aa3b2';
      cctx.font = '500 18px "Segoe UI", system-ui, sans-serif';
      cctx.textAlign = 'left';
      cctx.textBaseline = 'top';
      cctx.fillText('chose n=' + chosenN + '  ·  candidates: ' + s.candidates.map(c => '"' + c + '"').join(', ') + '  ·  hue ' + s.hue + '°', 20, top + ICON_BIG + 6);
      cctx.fillStyle = '#cbd5e1';
      cctx.font = '400 14px "Segoe UI", system-ui, sans-serif';
      cctx.fillText(s.note, 20, top + ICON_BIG + 32);
    }

    return composite.toDataURL('image/png');
  })()`;
}

// Builds a canvas script that stacks the thumbnail card at small + large
// sizes for each scenario, with a label. The actual buildScript() runs in
// Node (host-side) so it can use its module-scope constants; we embed the
// per-scenario rendered scripts as serialized strings to be eval'd inside
// the renderer alongside the composite drawing.
const THUMB_SMALL_W = 280, THUMB_SMALL_H = 158;
const THUMB_LARGE_W = 1280, THUMB_LARGE_H = 720;

function thumbnailGridScript(scenarios) {
  // Pre-build each scenario's canvas script on the Node side so module-scope
  // closures (BG, FG, FONT_STACK, …) inside prompt-thumbnail are captured.
  const small = scenarios.map(sc => promptThumbnail.buildScript({ ...sc, width: THUMB_SMALL_W, height: THUMB_SMALL_H }));
  const large = scenarios.map(sc => promptThumbnail.buildScript({ ...sc, width: THUMB_LARGE_W, height: THUMB_LARGE_H }));

  return `(async function(){
    const scenarios = ${JSON.stringify(scenarios.map(sc => ({ name: sc.name, cli: sc.cli, isWorking: sc.isWorking, ageLabel: sc.ageLabel })))};
    const smallScripts = ${JSON.stringify(small)};
    const largeScripts = ${JSON.stringify(large)};
    const PAD = 24;
    const LABEL_H = 50;
    const SMALL_W = ${THUMB_SMALL_W}, SMALL_H = ${THUMB_SMALL_H};
    const LARGE_W = ${THUMB_LARGE_W}, LARGE_H = ${THUMB_LARGE_H};
    const PREVIEW_LARGE_W = Math.round(LARGE_W / 2);
    const PREVIEW_LARGE_H = Math.round(LARGE_H / 2);
    const ROW_H = LABEL_H + Math.max(SMALL_H, PREVIEW_LARGE_H) + PAD;
    const W = PAD + SMALL_W + PAD + PREVIEW_LARGE_W + PAD;
    const H = scenarios.length * ROW_H + PAD;

    const composite = document.createElement('canvas');
    composite.width = W;
    composite.height = H;
    const cctx = composite.getContext('2d');
    cctx.fillStyle = '#0b1220';
    cctx.fillRect(0, 0, W, H);

    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      const top = PAD + i * ROW_H;

      cctx.fillStyle = '#cbd5e1';
      cctx.font = '600 18px "Segoe UI", system-ui, sans-serif';
      cctx.textAlign = 'left';
      cctx.textBaseline = 'top';
      cctx.fillText(sc.name, PAD, top);
      cctx.fillStyle = '#9aa3b2';
      cctx.font = '400 13px "Segoe UI", system-ui, sans-serif';
      cctx.fillText(sc.cli + '  ·  ' + (sc.isWorking ? 'working' : 'idle') + '  ·  ' + sc.ageLabel, PAD, top + 22);

      // The thumbnail script is now an async IIFE (it awaits an Image to
      // load for the brand icon), so eval'ing it returns a Promise — await
      // that to get the data URL before constructing the <img>.
      const smallURL = await eval(smallScripts[i]);
      const smallImg = new Image();
      await new Promise((res, rej) => { smallImg.onload = res; smallImg.onerror = rej; smallImg.src = smallURL; });
      cctx.drawImage(smallImg, PAD, top + LABEL_H, SMALL_W, SMALL_H);
      cctx.fillStyle = '#6c7480';
      cctx.font = '400 11px "Segoe UI", system-ui, sans-serif';
      cctx.fillText('280×158 (DWM thumbnail size)', PAD, top + LABEL_H + SMALL_H + 4);

      const largeURL = await eval(largeScripts[i]);
      const largeImg = new Image();
      await new Promise((res, rej) => { largeImg.onload = res; largeImg.onerror = rej; largeImg.src = largeURL; });
      const lx = PAD + SMALL_W + PAD;
      cctx.drawImage(largeImg, lx, top + LABEL_H, PREVIEW_LARGE_W, PREVIEW_LARGE_H);
      cctx.fillStyle = '#6c7480';
      cctx.font = '400 11px "Segoe UI", system-ui, sans-serif';
      cctx.fillText('1280×720 (Aero Peek size, shown at 50%)', lx, top + LABEL_H + PREVIEW_LARGE_H + 4);
    }

    return composite.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');

  // ---- icon grid ----
  {
    const dataURL = await win.webContents.executeJavaScript(iconGridScript(ICON_SAMPLES));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, 'icon-grid.png');
    fs.writeFileSync(file, png);
    console.log('wrote ' + file);
  }

  // ---- thumbnail grid ----
  {
    const dataURL = await win.webContents.executeJavaScript(thumbnailGridScript(THUMB_SCENARIOS));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, 'thumbnail-card.png');
    fs.writeFileSync(file, png);
    console.log('wrote ' + file);
  }

  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
