// Design exploration — KEPT FOR REFERENCE, NOT RUN BY DEFAULT.
//
// What this script does:
//   Renders 4 stacked Windows-taskbar mockups (12 sessions each) comparing
//   *surface treatments* applied uniformly to every session — the surface is
//   purely aesthetic, NOT a distinguisher. All variants use the same OKLCH
//   hue rotation; only how the colored tile is filled differs:
//
//     a) Flat color                 — solid OKLCH fill (Material Design style)
//     b) Subtle linear gradient     — top lighter, bottom darker (modern app icon style)
//     c) Glossy radial highlight    — top-left bright spot (iOS style)
//     d) Inset top highlight        — thin lit edge along the top, otherwise flat
//
// Why it exists:
//   After settling on "pure color with no per-session secondary cue" (see
//   scripts/preview-variants.js), the question became: can we make the icons
//   look more "designed" without adding cognitive cost? Aesthetic treatment
//   is shared across all sessions — it does NOT distinguish them, color does.
//
// Outcome (and why we kept the script):
//   The user picked (d) Inset top highlight — barely visible at 24px (which is
//   what they actually wanted), gives the icon a quiet "real app" feel without
//   competing with hue recognition. That treatment is what's now in
//   src/main.js iconRenderScript.
//
//   Rerun this script if you ever want to swap aesthetic — e.g., decide the
//   inset highlight is too subtle on real Windows hardware, or the linear
//   gradient would feel more polished.
//
// Usage: npx electron scripts/preview-aesthetic.js
// Output: ./icon-preview/aesthetic-{1x,2x}.png

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const ICON_HUE_STEP = 24;
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

function renderScript(sessions, scale) {
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
    const LABEL_PX = 14 * SCALE;
    const PANEL_LABEL_HEIGHT = 32 * SCALE;
    const PANEL_GAP = 8 * SCALE;

    const sessions = ${JSON.stringify(sessions)};
    const variants = [
      { id: 'flat',     label: 'a) Flat color  (current default)' },
      { id: 'linear',   label: 'b) Subtle linear gradient  (top lighter, bottom darker)' },
      { id: 'radial',   label: 'c) Glossy radial highlight  (top-left bright spot, like iOS)' },
      { id: 'innerlit', label: 'd) Inset top highlight  (single thin lit edge, otherwise flat)' },
    ];

    const W = PAD_LEFT_FIRST + sessions.length * BUTTON_W + 12 * SCALE;
    const PANEL_H = PANEL_LABEL_HEIGHT + TASKBAR_HEIGHT;
    const H = variants.length * (PANEL_H + PANEL_GAP) + PANEL_GAP;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    function ok(L, C, h) { return 'oklch(' + L + '% ' + C + ' ' + h + ')'; }

    function roundedRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawFlat(ix, iy, hue) {
      ctx.fillStyle = ok(${OKLCH_L}, ${OKLCH_C}, hue);
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.fill();
    }

    function drawLinear(ix, iy, hue) {
      const g = ctx.createLinearGradient(ix, iy, ix, iy + ICON);
      g.addColorStop(0, ok(72, ${OKLCH_C}, hue));
      g.addColorStop(1, ok(56, ${OKLCH_C}, hue));
      ctx.fillStyle = g;
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.fill();
    }

    function drawRadial(ix, iy, hue) {
      const cx = ix + ICON * 0.32, cy = iy + ICON * 0.32;
      const g = ctx.createRadialGradient(cx, cy, 0, ix + ICON / 2, iy + ICON / 2, ICON * 0.85);
      g.addColorStop(0, ok(78, ${OKLCH_C * 0.85}, hue));
      g.addColorStop(1, ok(58, ${OKLCH_C}, hue));
      ctx.fillStyle = g;
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.fill();
    }

    function drawInnerLit(ix, iy, hue) {
      drawFlat(ix, iy, hue);
      // Thin lighter band along the top inside edge — about 12% of icon height.
      ctx.save();
      roundedRectPath(ix, iy, ICON, ICON, ICON_RX);
      ctx.clip();
      const g = ctx.createLinearGradient(ix, iy, ix, iy + ICON * 0.35);
      g.addColorStop(0, 'rgba(255,255,255,0.32)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(ix, iy, ICON, ICON * 0.35);
      ctx.restore();
    }

    const DRAW = { flat: drawFlat, linear: drawLinear, radial: drawRadial, innerlit: drawInnerLit };

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

    variants.forEach((v, panelIdx) => {
      const panelTop = PANEL_GAP + panelIdx * (PANEL_H + PANEL_GAP);
      const labelTop = panelTop;
      const taskbarTop = panelTop + PANEL_LABEL_HEIGHT;

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 ' + LABEL_PX + 'px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.label, 14 * SCALE, labelTop + PANEL_LABEL_HEIGHT / 2);

      ctx.fillStyle = '#1c1c1c';
      ctx.fillRect(0, taskbarTop, W, TASKBAR_HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, taskbarTop, W, 1 * SCALE);

      const iconY = taskbarTop + (TASKBAR_HEIGHT - ICON) / 2;
      sessions.forEach((s, i) => {
        const buttonX = PAD_LEFT_FIRST + i * BUTTON_W;
        const iconX = buttonX + ICON_X_PAD;
        DRAW[v.id](iconX, iconY, s.hue);
        const textX = iconX + ICON + ICON_TEXT_GAP;
        const textMaxW = (buttonX + BUTTON_W) - textX - 8 * SCALE;
        drawTitleAt(s.title, textX, taskbarTop + TASKBAR_HEIGHT / 2, textMaxW);
      });
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
    const dataURL = await win.webContents.executeJavaScript(renderScript(sessions, scale));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, scale === 1 ? 'aesthetic-1x.png' : 'aesthetic-2x.png');
    fs.writeFileSync(file, png);
    console.log(`scale ${scale}x → ${file} (${png.length} bytes)`);
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
