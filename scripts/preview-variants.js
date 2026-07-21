// Design exploration — KEPT FOR REFERENCE, NOT RUN BY DEFAULT.
//
// What this script does:
//   Renders 4 stacked Windows-taskbar mockups (12 sessions each) to compare
//   *secondary cue* approaches that augment the primary OKLCH hue rotation:
//
//     a) Pure color                 — hue only, no secondary cue
//     b) Color + shape              — rounded square / circle / hexagon / diamond
//                                     advancing every session
//     c) Color + two-tone split     — same hue at two lightnesses, split direction
//                                     (vert / horiz / diag-down / diag-up)
//                                     advancing every session
//     d) Color + corner accent      — small white dot in TL/TR/BL/BR corner,
//                                     advancing every session
//
// Why it exists:
//   When designing the per-window taskbar icon (see src/main.js iconRenderScript),
//   we considered whether to add a *per-session* secondary cue on top of hue, so
//   that sessions with similar hues could still be told apart. This script let us
//   eyeball each candidate at realistic Windows-taskbar pixel size before committing.
//
// Outcome (and why we kept the script):
//   The user picked (a) pure color with the OKLCH 24-degree step — 15 perceptually-
//   uniform hues is enough for typical concurrent session counts (5-15), and any
//   per-session secondary cue costs cognitive load. We aestheticized via a separate
//   inset top highlight (see scripts/preview-aesthetic.js) that's an aesthetic
//   constant, NOT a per-session distinguisher.
//
//   Rerun this script if you ever want to revisit "should I add a per-session
//   secondary cue?" — for example, if your concurrent count grows past ~12 and
//   hue collisions become annoying. The cycling math in src/main.js stays the
//   same; only the renderer changes.
//
// Usage: npx electron scripts/preview-variants.js
// Output: ./icon-preview/variants-{1x,2x}.png

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const ICON_HUE_STEP = 24;        // 15 perceptually-distinct hues per full wheel
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

function renderScript(sessions, scale, sessionsPerVariant) {
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
    const variants = ['pure', 'shape', 'split', 'corner'];
    const variantLabels = {
      pure:   'a) Pure color',
      shape:  'b) Color + shape  (rounded square / circle / hexagon / diamond)',
      split:  'c) Color + two-tone split  (vertical / horizontal / diag-down / diag-up)',
      corner: 'd) Color + corner accent  (TL / TR / BL / BR)',
    };

    const W = PAD_LEFT_FIRST + sessions.length * BUTTON_W + 12 * SCALE;
    const PANEL_H = PANEL_LABEL_HEIGHT + TASKBAR_HEIGHT;
    const H = variants.length * (PANEL_H + PANEL_GAP) + PANEL_GAP;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Page background
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    function roundedRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function clipRoundedRect(x, y, w, h, r) {
      ctx.save();
      roundedRect(x, y, w, h, r);
      ctx.clip();
    }

    function ok(L, C, h) { return 'oklch(' + L + '% ' + C + ' ' + h + ')'; }

    // -- shape draws (filled, fully inscribed in the icon bounding box) --
    function drawRoundedSquare(ix, iy, hue) {
      ctx.fillStyle = ok(${OKLCH_L}, ${OKLCH_C}, hue);
      roundedRect(ix, iy, ICON, ICON, ICON_RX);
      ctx.fill();
    }
    function drawCircle(ix, iy, hue) {
      ctx.fillStyle = ok(${OKLCH_L}, ${OKLCH_C}, hue);
      ctx.beginPath();
      ctx.arc(ix + ICON / 2, iy + ICON / 2, ICON / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    function drawHexagon(ix, iy, hue) {
      // flat-top hexagon inscribed in the icon box
      ctx.fillStyle = ok(${OKLCH_L}, ${OKLCH_C}, hue);
      const cx = ix + ICON / 2, cy = iy + ICON / 2;
      const r = ICON / 2;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + k * Math.PI / 3;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    function drawDiamond(ix, iy, hue) {
      ctx.fillStyle = ok(${OKLCH_L}, ${OKLCH_C}, hue);
      const cx = ix + ICON / 2, cy = iy + ICON / 2;
      const r = ICON / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
    }
    const SHAPES = [drawRoundedSquare, drawCircle, drawHexagon, drawDiamond];

    // -- two-tone split: same hue, two lightnesses; cycles 4 split orientations --
    function drawSplit(ix, iy, hue, splitIdx) {
      const lighter = ok(72, ${OKLCH_C}, hue);
      const darker  = ok(54, ${OKLCH_C}, hue);
      clipRoundedRect(ix, iy, ICON, ICON, ICON_RX);
      ctx.fillStyle = lighter;
      ctx.fillRect(ix, iy, ICON, ICON);
      ctx.fillStyle = darker;
      ctx.beginPath();
      if (splitIdx === 0) {        // vertical split, right half darker
        ctx.moveTo(ix + ICON / 2, iy);
        ctx.lineTo(ix + ICON, iy);
        ctx.lineTo(ix + ICON, iy + ICON);
        ctx.lineTo(ix + ICON / 2, iy + ICON);
      } else if (splitIdx === 1) {  // horizontal, bottom darker
        ctx.moveTo(ix, iy + ICON / 2);
        ctx.lineTo(ix + ICON, iy + ICON / 2);
        ctx.lineTo(ix + ICON, iy + ICON);
        ctx.lineTo(ix, iy + ICON);
      } else if (splitIdx === 2) {  // diagonal, BR triangle darker
        ctx.moveTo(ix, iy + ICON);
        ctx.lineTo(ix + ICON, iy);
        ctx.lineTo(ix + ICON, iy + ICON);
      } else {                       // diagonal opposite, TR triangle darker
        ctx.moveTo(ix, iy);
        ctx.lineTo(ix + ICON, iy);
        ctx.lineTo(ix + ICON, iy + ICON);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // -- corner accent: small white dot in one of 4 corners --
    function drawCorner(ix, iy, hue, cornerIdx) {
      drawRoundedSquare(ix, iy, hue);
      const dot = ICON * 0.22;
      const inset = ICON * 0.16;
      let cx, cy;
      if (cornerIdx === 0) { cx = ix + inset + dot / 2;          cy = iy + inset + dot / 2; }
      else if (cornerIdx === 1) { cx = ix + ICON - inset - dot / 2; cy = iy + inset + dot / 2; }
      else if (cornerIdx === 2) { cx = ix + inset + dot / 2;        cy = iy + ICON - inset - dot / 2; }
      else                      { cx = ix + ICON - inset - dot / 2; cy = iy + ICON - inset - dot / 2; }
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(cx, cy, dot / 2, 0, Math.PI * 2);
      ctx.fill();
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

    function drawPanel(panelIdx, variant) {
      const panelTop = PANEL_GAP + panelIdx * (PANEL_H + PANEL_GAP);
      const labelTop = panelTop;
      const taskbarTop = panelTop + PANEL_LABEL_HEIGHT;

      // panel label
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 ' + LABEL_PX + 'px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(variantLabels[variant], 14 * SCALE, labelTop + PANEL_LABEL_HEIGHT / 2);

      // taskbar background
      ctx.fillStyle = '#1c1c1c';
      ctx.fillRect(0, taskbarTop, W, TASKBAR_HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, taskbarTop, W, 1 * SCALE);

      const iconY = taskbarTop + (TASKBAR_HEIGHT - ICON) / 2;
      sessions.forEach((s, i) => {
        const buttonX = PAD_LEFT_FIRST + i * BUTTON_W;
        const iconX = buttonX + ICON_X_PAD;
        if (variant === 'pure') {
          drawRoundedSquare(iconX, iconY, s.hue);
        } else if (variant === 'shape') {
          SHAPES[i % 4](iconX, iconY, s.hue);
        } else if (variant === 'split') {
          drawSplit(iconX, iconY, s.hue, i % 4);
        } else if (variant === 'corner') {
          drawCorner(iconX, iconY, s.hue, i % 4);
        }
        const textX = iconX + ICON + ICON_TEXT_GAP;
        const textMaxW = (buttonX + BUTTON_W) - textX - 8 * SCALE;
        drawTitleAt(s.title, textX, taskbarTop + TASKBAR_HEIGHT / 2, textMaxW);
      });
    }

    variants.forEach((v, i) => drawPanel(i, v));

    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const sessions = SAMPLE_TITLES.map((title, idx) => ({
    idx,
    title,
    hue: (idx * ICON_HUE_STEP) % 360,
  }));

  for (const scale of [1, 2]) {
    const dataURL = await win.webContents.executeJavaScript(renderScript(sessions, scale, sessions.length));
    const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(outDir, scale === 1 ? 'variants-1x.png' : 'variants-2x.png');
    fs.writeFileSync(file, png);
    console.log(`scale ${scale}x → ${file} (${png.length} bytes)`);
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
