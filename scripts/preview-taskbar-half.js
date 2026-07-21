// Mockup of the half-color half-letter icon variant on a Windows-11-style
// dark taskbar, with each button showing the "rest of prompt" as text.

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const SAMPLES = [
  { idx: 0,  prompt: 'Fix the auth bug' },
  { idx: 1,  prompt: 'Code review the PR' },
  { idx: 2,  prompt: 'Refactor the middleware' },
  { idx: 3,  prompt: 'Update the markdown docs' },
  { idx: 4,  prompt: 'Investigate the flaky login test' },
  { idx: 5,  prompt: 'Migrate database schema' },
  { idx: 6,  prompt: '✻ Polish welcome screen' },
  { idx: 7,  prompt: '"fix-upload-retry-logic"' },
];

const ICON_HUE_STEP = 24;
const OKLCH_L = 65;
const OKLCH_C = 0.17;

function firstLetterOf(prompt) {
  const idx = (prompt || '').search(/[A-Za-z]/);
  if (idx < 0) return { letter: '?', restFrom: 0 };
  return { letter: prompt[idx].toUpperCase(), restFrom: idx + 1 };
}

function renderScript(sessions, scale) {
  return `(function(){
    const SCALE = ${scale};
    const TASKBAR_HEIGHT = 48 * SCALE;
    const ICON = 24 * SCALE;
    const ICON_RX = 6 * SCALE;
    const BUTTON_W = 220 * SCALE;
    const PAD_LEFT_FIRST = 12 * SCALE;
    const ICON_X_PAD = 12 * SCALE;
    const ICON_TEXT_GAP = 0 * SCALE;          // letter and rest visually merge
    const FONT_PX = 12 * SCALE;

    const sessions = ${JSON.stringify(sessions)};
    const W = PAD_LEFT_FIRST + sessions.length * BUTTON_W + 12 * SCALE;
    const H = TASKBAR_HEIGHT + 64 * SCALE;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Desktop strip + taskbar bg.
    const grad = ctx.createLinearGradient(0, 0, 0, H - TASKBAR_HEIGHT);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H - TASKBAR_HEIGHT);

    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, H - TASKBAR_HEIGHT, W, TASKBAR_HEIGHT);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, H - TASKBAR_HEIGHT, W, 1 * SCALE);

    // Rect with only the LEFT corners rounded — silhouette extends into the
    // letter zone visually. The right edge then alpha-fades into transparent
    // for a soft "ease to" letter handoff.
    function leftRoundedRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    }

    function drawIcon(s, ix, iy) {
      const w = ICON, h = ICON;
      const chipW = w / 2;
      // Make the chip slightly wider so the alpha fade has room to live
      // without eating into the solid colored area.
      const chipExtra = w * 0.10;
      const chipFullW = chipW + chipExtra;
      const fadeStart = chipW * 0.85;        // start fading 85% across the original chip
      ctx.save();
      leftRoundedRectPath(ix, iy, chipFullW, h, ICON_RX);
      ctx.clip();
      const hueFill = 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ')';
      // Solid color through fadeStart, then fade to transparent across the rest.
      const fade = ctx.createLinearGradient(ix + fadeStart, iy, ix + chipFullW, iy);
      fade.addColorStop(0, hueFill);
      fade.addColorStop(1, 'oklch(${OKLCH_L}% ${OKLCH_C} ' + s.hue + ' / 0)');
      ctx.fillStyle = hueFill;
      ctx.fillRect(ix, iy, fadeStart, h);
      ctx.fillStyle = fade;
      ctx.fillRect(ix + fadeStart, iy, chipFullW - fadeStart, h);
      // Subtle inset top highlight on the chip.
      const hi = ctx.createLinearGradient(ix, iy, ix, iy + h * 0.35);
      hi.addColorStop(0, 'rgba(255,255,255,0.18)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hi;
      ctx.fillRect(ix, iy, chipFullW, h * 0.35);
      ctx.restore();

      // Right half: transparent. Letter only, in taskbar text color/font.
      ctx.fillStyle = '#cccccc';
      ctx.font = '500 ' + Math.round(h * 0.5) + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.letter, ix + w * 0.75, iy + h / 2 + h * 0.02);
    }

    function drawTitleAt(text, tx, ty, maxW) {
      ctx.save();
      ctx.fillStyle = '#e6e6e6';
      ctx.font = '400 ' + FONT_PX + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
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
      drawIcon(s, iconX, iconY);
      const textX = iconX + ICON + ICON_TEXT_GAP;
      const textMaxW = (buttonX + BUTTON_W) - textX - 8 * SCALE;
      drawTitleAt(s.rest, textX, taskbarTop + TASKBAR_HEIGHT / 2, textMaxW);
    });

    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 1000, height: 600 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const sessions = SAMPLES.map(s => {
    const { letter, restFrom } = firstLetterOf(s.prompt);
    return {
      idx: s.idx,
      hue: (s.idx * ICON_HUE_STEP) % 360,
      letter,
      rest: s.prompt.slice(restFrom),
    };
  });

  for (const scale of [1, 2]) {
    const dataURL = await win.webContents.executeJavaScript(renderScript(sessions, scale));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, scale === 1 ? 'taskbar-half-1x.png' : 'taskbar-half-2x.png');
    fs.writeFileSync(file, png);
    console.log(`scale ${scale}x → ${file} (${png.length} bytes)`);
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
