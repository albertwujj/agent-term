// Local thumbnail-sharpness preview. Renders the same canvas script the
// production app uses (buildScript in src/prompt-thumbnail.js) inside a
// headless Electron BrowserWindow — so the bitmaps come out of the SAME
// Chromium build the shipped app uses, not your system browser. Then
// writes an HTML viewer that displays each variant at native 200x112
// alongside a CSS-bilinear upscale to ~840x474 — matching the ratio DWM
// applies on a 300%-scale 5120x2880 display.
//
// Usage:  npx electron scripts/preview-thumbnail.js
// Output: ./icon-preview/preview.html (opened automatically)

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { buildScript } = require('../src/prompt-thumbnail');

// Long enough to wrap to multiple lines so we can see how each variant
// handles a realistic continuation payload.
const SAMPLE_OVERFLOW =
  'continuation text that overflows past chrome top into our card. Word boundaries keep wrap clean.';

const W = 200;
const H = 112;

// Approximate DWM display size of the thumbnail popup on a 300%-scale
// 5120x2880 display. Adjust if your display scale differs.
const TARGET_W = 840;
const TARGET_H = 470;

const FONT_CASCADIA = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace';
const FONT_SEGOE    = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

const VARIANTS = [
  // Baseline (your prior pick) for comparison.
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '600', fontPxRatio: 0.135 },
  // Heavier weights at the same size — testing if bolder reads sharper
  // through DWM's bilinear upscale. Segoe UI Variable Text supports a
  // continuous weight axis, so non-named values like 650 also work.
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '650', fontPxRatio: 0.135 },
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '700', fontPxRatio: 0.135 },
  // Heavier at slightly smaller / larger sizes — heaviness without
  // necessarily making glyphs bigger.
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '700', fontPxRatio: 0.125 },
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '700', fontPxRatio: 0.145 },
  // 900 / black — see how it looks; might be too heavy at this size.
  { font: FONT_SEGOE, fontLabel: 'Segoe UI', fontWeight: '900', fontPxRatio: 0.135 },
];

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const rendered = [];
  for (const v of VARIANTS) {
    const script = buildScript({
      width: W,
      height: H,
      firstPromptOverflow: SAMPLE_OVERFLOW,
      fontWeight: v.fontWeight,
      fontPxRatio: v.fontPxRatio,
      fontStack: v.font,
    });
    const dataURL = await win.webContents.executeJavaScript(script);
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const safeFont = v.fontLabel.replace(/\s+/g, '-').toLowerCase();
    const filename = `${safeFont}-w${v.fontWeight}-s${Math.round(v.fontPxRatio * 1000)}.png`;
    fs.writeFileSync(path.join(outDir, filename), png);
    rendered.push({
      label: `${v.fontLabel} · weight ${v.fontWeight} · size ${(v.fontPxRatio * 100).toFixed(1)}%`,
      filename,
    });
    console.log(`${v.fontLabel.padEnd(15)} w${v.fontWeight} / ${v.fontPxRatio}   ${png.length} bytes  → ${filename}`);
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Thumbnail sharpness preview</title>
<style>
  body { background: #1e1e1e; color: #ddd; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 4px 0; }
  .note { color: #999; font-size: 12px; margin-bottom: 24px; max-width: 900px; line-height: 1.5; }
  .row { display: flex; gap: 24px; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #333; align-items: flex-start; }
  .col-label { width: 260px; color: #ccc; padding-top: 18px; font-weight: 500; }
  .col-native { width: 200px; }
  .col-up { flex: 1; }
  img.native { display: block; width: 200px; height: 112px; image-rendering: pixelated; background: #f6f6f6; }
  img.upscaled { display: block; width: ${TARGET_W}px; height: ${TARGET_H}px; image-rendering: auto; background: #f6f6f6; }
  .label-sub { color: #777; font-size: 11px; margin-bottom: 6px; }
</style>
</head>
<body>
<h1>Thumbnail sharpness preview</h1>
<p class="note">
  Rendered via headless Electron (same Chromium build as the shipped app).
  Left column: source bitmap at native 200×112 (sharp). Right column: same
  bitmap CSS-scaled to ${TARGET_W}×${TARGET_H} with bilinear filtering —
  simulates DWM's upscale on a 300%-scale display. Pick the row whose right
  column reads cleanest.
</p>
<div id="root">
${rendered.map((r) => `
  <div class="row">
    <div class="col-label">${r.label}</div>
    <div class="col-native">
      <div class="label-sub">source 200×112</div>
      <img class="native" src="${r.filename}">
    </div>
    <div class="col-up">
      <div class="label-sub">bilinear upscale ${TARGET_W}×${TARGET_H} (DWM-simulated)</div>
      <img class="upscaled" src="${r.filename}">
    </div>
  </div>`).join('')}
</div>
</body>
</html>`;

  const htmlPath = path.join(outDir, 'preview.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`\npreview: ${htmlPath}`);
  shell.openPath(htmlPath);
  win.destroy();
  app.quit();
});
