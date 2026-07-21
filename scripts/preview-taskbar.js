// Live preview — mirrors the production icon recipe in src/main.js.
// Renders a Windows 11 taskbar mockup (12 sessions) at realistic pixel size
// so you can preview at-a-glance scannability before deploying to Windows.
//
// 1x = a Windows 100% DPI taskbar (24px icons). 2x is provided so the icons
// are easier to inspect on a Mac display while developing.
//
// Design exploration scripts (kept for reference, not the live recipe):
//   scripts/preview-variants.js   — comparing per-session secondary cues
//   scripts/preview-aesthetic.js  — comparing aesthetic surface treatments
//
// Usage: npx electron scripts/preview-taskbar.js
// Output: ./icon-preview/taskbar-mockup-{1x,2x}.png

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const ICON_HUE_STEP = 24;     // matches src/main.js
const OKLCH_L = 65;
const OKLCH_C = 0.17;

const SAMPLE_TITLES = [
  'Code Document Updater',
  'Profile the slow query',
  'Investigate the flaky login test',
  'Refactor auth middleware',
  'Fix WebSocket race condition',
  'Update CLAUDE.md',
  'Add release script flags',
  'Debug taskbar icon rendering',
  'Migrate database schema',
  'Add per-session icon spec',
  'Trace renderer IPC latency',
  'Polish welcome screen',
];

function taskbarRenderScript(sessions, scale) {
  return `(function(){
    const SCALE = ${scale};
    const TASKBAR_HEIGHT = 48 * SCALE;
    const ICON = 24 * SCALE;
    const ICON_RX = 6 * SCALE;
    const BUTTON_W = 200 * SCALE;
    const PAD_LEFT_FIRST = 12 * SCALE;
    const ICON_X_PAD = 12 * SCALE;
    const ICON_TEXT_GAP = 10 * SCALE;
    const FONT_PX = 12 * SCALE;

    const sessions = ${JSON.stringify(sessions)};
    const W = PAD_LEFT_FIRST + sessions.length * BUTTON_W + 12 * SCALE;
    const H = TASKBAR_HEIGHT + 80 * SCALE;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, H - TASKBAR_HEIGHT);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H - TASKBAR_HEIGHT);

    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, H - TASKBAR_HEIGHT, W, TASKBAR_HEIGHT);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, H - TASKBAR_HEIGHT, W, 1 * SCALE);

    function roundedRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawIconAt(s, ix, iy) {
      ctx.save();
      ctx.fillStyle = 'oklch(' + ${OKLCH_L} + '% ' + ${OKLCH_C} + ' ' + s.hue + ')';
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.fill();
      // Inset top highlight
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.clip();
      const hi = ctx.createLinearGradient(ix, iy, ix, iy + ICON * 0.35);
      hi.addColorStop(0, 'rgba(255,255,255,0.32)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hi;
      ctx.fillRect(ix, iy, ICON, ICON * 0.35);
      ctx.restore();
    }

    function drawTitleAt(text, tx, ty, maxW) {
      ctx.save();
      ctx.fillStyle = '#e6e6e6';
      ctx.font = '400 ' + FONT_PX + 'px "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let t = text;
      if (ctx.measureText(t).width > maxW) {
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        t = t + '…';
      }
      ctx.fillText(t, tx, ty);
      ctx.restore();
    }

    const taskbarTop = H - TASKBAR_HEIGHT;
    const iconY = taskbarTop + (TASKBAR_HEIGHT - ICON) / 2;

    sessions.forEach((s, i) => {
      const buttonX = PAD_LEFT_FIRST + i * BUTTON_W;
      const iconX = buttonX + ICON_X_PAD;
      drawIconAt(s, iconX, iconY);
      const textX = iconX + ICON + ICON_TEXT_GAP;
      const textMaxW = (buttonX + BUTTON_W) - textX - 8 * SCALE;
      drawTitleAt(s.title, textX, taskbarTop + TASKBAR_HEIGHT / 2, textMaxW);
    });

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 ' + (10 * SCALE) + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    sessions.forEach((s, i) => {
      const buttonX = PAD_LEFT_FIRST + i * BUTTON_W;
      ctx.fillText('session ' + s.idx, buttonX + BUTTON_W / 2, taskbarTop - 18 * SCALE);
    });

    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const sessions = SAMPLE_TITLES.map((title, idx) => ({
    idx, title, hue: (idx * ICON_HUE_STEP) % 360,
  }));

  for (const scale of [1, 2]) {
    const dataURL = await win.webContents.executeJavaScript(taskbarRenderScript(sessions, scale));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, scale === 1 ? 'taskbar-mockup-1x.png' : 'taskbar-mockup-2x.png');
    fs.writeFileSync(file, png);
    console.log(`scale ${scale}x → ${file} (${png.length} bytes)`);
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
