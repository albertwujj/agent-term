// Live preview — mirrors the production icon recipe in src/main.js.
// Renders the 15 distinct hues of one full cycle as 256x256 PNGs.
//
// Use this to verify how an individual icon looks at high res. For an
// at-a-glance scannability test (a row of icons next to titles, like the
// Windows taskbar), use scripts/preview-taskbar.js instead.
//
// Design exploration scripts (kept for reference, not the live recipe):
//   scripts/preview-variants.js   — comparing per-session secondary cues
//   scripts/preview-aesthetic.js  — comparing aesthetic surface treatments
//
// Usage: npx electron scripts/preview-icons.js
// Output: ./icon-preview/{00..14}-h{hue}.png

const { app, BrowserWindow, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const ICON_HUE_STEP = 24;     // matches src/main.js
const OKLCH_L = 65;
const OKLCH_C = 0.17;
const NUM_HUES = 15;          // one full perceptual rotation

function renderIconScript(hue) {
  const fill = `oklch(${OKLCH_L}% ${OKLCH_C} ${hue})`;
  return `(function(){
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    const r = 44, x = 20, y = 20, w = 216, h = 216;
    function path() {
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y, x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x, y+h, r);
      ctx.arcTo(x, y+h, x, y, r);
      ctx.arcTo(x, y, x+w, y, r);
      ctx.closePath();
    }
    ctx.fillStyle = ${JSON.stringify(fill)};
    path();
    ctx.fill();
    ctx.save();
    path();
    ctx.clip();
    const hi = ctx.createLinearGradient(x, y, x, y + h * 0.35);
    hi.addColorStop(0, 'rgba(255,255,255,0.32)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hi;
    ctx.fillRect(x, y, w, h * 0.35);
    ctx.restore();
    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  for (let i = 0; i < NUM_HUES; i++) {
    const hue = (i * ICON_HUE_STEP) % 360;
    const dataURL = await win.webContents.executeJavaScript(renderIconScript(hue));
    const img = nativeImage.createFromDataURL(dataURL);

    if (img.isEmpty()) {
      console.error(`session ${i} (hue ${hue}): EMPTY`);
      continue;
    }

    const png = img.toPNG();
    const file = path.join(outDir, `${String(i).padStart(2, '0')}-h${String(hue).padStart(3, '0')}.png`);
    fs.writeFileSync(file, png);
    console.log(`session ${i}: hue ${hue}  (${png.length} bytes)`);
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
