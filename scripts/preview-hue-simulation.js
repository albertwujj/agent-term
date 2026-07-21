// Visual preview of the max-min hue picker over a 30-session simulation
// with FIFO eviction at cap=10. Renders:
//   1. Header summary
//   2. Sequential timeline — 30 colored chips with session # and hue value
//   3. Color wheel — the final 10 active hues placed around the circle,
//      with gap arcs labeled, so the spacing is visible at a glance

const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { pickNextHue } = require('../src/hue-assign');

const CAP = 10;
const TOTAL_SESSIONS = 30;
// Anchor for the very first session — picked deliberately (sky/cyan)
// rather than the legacy cycleIconParams(0)=0° (hot pink). All subsequent
// sessions still max-min from there, so the wheel coverage shape is
// the same — just rotated to put #1 at a friendly productivity-tool hue.
const START_HUE = 210;
// Chroma knob — 0.17 is muted-but-saturated; 0.22 pushes toward more
// "common color" recognition (true red vs hot pink, true green vs
// chartreuse, royal blue vs medium blue). Some hues may bump against
// the sRGB gamut at higher C; the browser gamut-maps the rest.
const PREVIEW_C = 0.27;
const PREVIEW_L = 65;

// Run the simulation; capture each session's hue + the active set after.
function runSimulation() {
  const active = [];
  const history = [];
  for (let i = 1; i <= TOTAL_SESSIONS; i++) {
    const fallback = i === 1 ? START_HUE : ((i - 1) * 24) % 360;
    const hue = pickNextHue(active, fallback);
    history.push({ session: i, hue, activeBefore: active.slice() });
    active.push(hue);
    if (active.length > CAP) active.shift();   // FIFO drop oldest
  }
  return { history, finalActive: active.slice() };
}

function round1(h) { return Math.round(h * 10) / 10; }

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const { history, finalActive } = runSimulation();

  const W = 1400;
  const H = 1400;
  const win = new BrowserWindow({
    show: false,
    width: W + 80,
    height: H + 80,
    backgroundColor: '#0b1220',
  });

  await win.loadURL('data:text/html;charset=utf-8,<html><body style="margin:0;background:#0b1220"></body></html>');

  const drawScript = `(function(){
    const W = ${W};
    const H = ${H};
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const HISTORY = ${JSON.stringify(history.map(h => ({ session: h.session, hue: h.hue })))};
    const FINAL = ${JSON.stringify(finalActive)};

    // ---- Header ----------------------------------------------------
    ctx.fillStyle = '#e6e6e6';
    ctx.font = '600 24px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Max-min hue picker — 30-session simulation with cap=10 FIFO eviction', 40, 30);

    ctx.fillStyle = '#9aa3b2';
    ctx.font = '400 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Each chip below is one session in creation order. The bottom wheel shows the final 10 active hues at session 30.', 40, 64);

    // ---- Timeline strip --------------------------------------------
    // 30 chips in 2 rows of 15. Each chip is ~85px wide, 90px tall.
    const CHIP_W = 86;
    const CHIP_H = 90;
    const CHIP_GAP = 4;
    const TIMELINE_TOP = 110;
    const TIMELINE_LEFT = 40;
    const PER_ROW = 15;

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Creation sequence (hues in degrees on the OKLCH wheel)', TIMELINE_LEFT, TIMELINE_TOP - 24);

    for (let i = 0; i < HISTORY.length; i++) {
      const row = Math.floor(i / PER_ROW);
      const col = i % PER_ROW;
      const x = TIMELINE_LEFT + col * (CHIP_W + CHIP_GAP);
      const y = TIMELINE_TOP + row * (CHIP_H + 30);

      const { session, hue } = HISTORY[i];
      // Mark evicted-vs-active in the final set: chips whose hue is in
      // FINAL are still alive at session 30, others have been dropped.
      const isAlive = FINAL.indexOf(hue) !== -1;

      // Color swatch
      ctx.fillStyle = 'oklch(${PREVIEW_L}% ${PREVIEW_C} ' + hue + ')';
      ctx.fillRect(x, y, CHIP_W, CHIP_H);

      // Slight darken at the bottom where the label sits
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y + CHIP_H - 36, CHIP_W, 36);

      // Session number (top-left)
      ctx.fillStyle = '#0c0c0c';
      ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('#' + session, x + 8, y + 8);

      // Indicator: faded if dropped
      if (!isAlive) {
        // Hatch overlay for evicted
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(x, y, CHIP_W, CHIP_H);
        ctx.restore();
        ctx.fillStyle = '#909090';
        ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText('evicted', x + 8, y + 28);
      }

      // Hue value (bottom)
      ctx.fillStyle = '#e6e6e6';
      ctx.font = '500 13px "Cascadia Mono", "Cascadia Code", Consolas, monospace';
      ctx.textBaseline = 'top';
      const huePretty = (Math.round(hue * 10) / 10).toFixed(1) + '°';
      ctx.fillText(huePretty, x + 8, y + CHIP_H - 26);
    }

    // ---- Color wheel -----------------------------------------------
    const WHEEL_CENTER_X = W / 2;
    const WHEEL_CENTER_Y = 470 + 320;
    const WHEEL_RADIUS_OUTER = 230;
    const WHEEL_RADIUS_INNER = 170;
    const WHEEL_LABEL_RADIUS = 270;
    const DOT_RADIUS = 22;

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Final 10 active hues at session 30 — placement on the OKLCH wheel', 40, WHEEL_CENTER_Y - WHEEL_RADIUS_OUTER - 60);

    // Faint hue ring backdrop (sampled at 1° increments).
    for (let deg = 0; deg < 360; deg += 1) {
      const a0 = ((deg - 0.5) * Math.PI) / 180;
      const a1 = ((deg + 0.5) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(
        WHEEL_CENTER_X + Math.cos(a0) * WHEEL_RADIUS_INNER,
        WHEEL_CENTER_Y + Math.sin(a0) * WHEEL_RADIUS_INNER,
      );
      ctx.arc(WHEEL_CENTER_X, WHEEL_CENTER_Y, WHEEL_RADIUS_OUTER, a0, a1);
      ctx.lineTo(
        WHEEL_CENTER_X + Math.cos(a1) * WHEEL_RADIUS_INNER,
        WHEEL_CENTER_Y + Math.sin(a1) * WHEEL_RADIUS_INNER,
      );
      ctx.arc(WHEEL_CENTER_X, WHEEL_CENTER_Y, WHEEL_RADIUS_INNER, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = 'oklch(58% 0.13 ' + deg + ' / 0.28)';
      ctx.fill();
    }

    // Cardinal-degree tick marks (0/90/180/270)
    ctx.strokeStyle = '#5a6373';
    ctx.lineWidth = 1;
    for (const deg of [0, 90, 180, 270]) {
      const a = (deg * Math.PI) / 180;
      const x0 = WHEEL_CENTER_X + Math.cos(a) * WHEEL_RADIUS_INNER;
      const y0 = WHEEL_CENTER_Y + Math.sin(a) * WHEEL_RADIUS_INNER;
      const x1 = WHEEL_CENTER_X + Math.cos(a) * WHEEL_RADIUS_OUTER;
      const y1 = WHEEL_CENTER_Y + Math.sin(a) * WHEEL_RADIUS_OUTER;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.fillStyle = '#7a8295';
      ctx.font = '400 11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lx = WHEEL_CENTER_X + Math.cos(a) * (WHEEL_RADIUS_OUTER + 18);
      const ly = WHEEL_CENTER_Y + Math.sin(a) * (WHEEL_RADIUS_OUTER + 18);
      ctx.fillText(deg + '°', lx, ly);
    }

    // Sorted active list for gap computation
    const sorted = FINAL.slice().sort((a, b) => a - b);

    // Draw gap arcs between consecutive hues (alternating subtle shade)
    for (let i = 0; i < sorted.length; i++) {
      const here = sorted[i];
      const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
      const gap = next - here;
      const midDeg = (here + gap / 2) % 360;
      const midA = (midDeg * Math.PI) / 180;
      const x = WHEEL_CENTER_X + Math.cos(midA) * (WHEEL_LABEL_RADIUS + 22);
      const y = WHEEL_CENTER_Y + Math.sin(midA) * (WHEEL_LABEL_RADIUS + 22);
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '500 12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((Math.round(gap * 10) / 10) + '°', x, y);
    }

    // Place dots at each final hue
    for (const hue of FINAL) {
      const a = (hue * Math.PI) / 180;
      const x = WHEEL_CENTER_X + Math.cos(a) * (WHEEL_RADIUS_INNER + (WHEEL_RADIUS_OUTER - WHEEL_RADIUS_INNER) / 2);
      const y = WHEEL_CENTER_Y + Math.sin(a) * (WHEEL_RADIUS_INNER + (WHEEL_RADIUS_OUTER - WHEEL_RADIUS_INNER) / 2);
      ctx.fillStyle = 'oklch(${PREVIEW_L}% ${PREVIEW_C} ' + hue + ')';
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0b1220';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Hue label outside the dot
      const lx = WHEEL_CENTER_X + Math.cos(a) * WHEEL_LABEL_RADIUS;
      const ly = WHEEL_CENTER_Y + Math.sin(a) * WHEEL_RADIUS_INNER * 0 + WHEEL_CENTER_Y;
      // place label at outer radius
      const labelX = WHEEL_CENTER_X + Math.cos(a) * WHEEL_LABEL_RADIUS;
      const labelY = WHEEL_CENTER_Y + Math.sin(a) * WHEEL_LABEL_RADIUS;
      ctx.fillStyle = '#e6e6e6';
      ctx.font = '500 13px "Cascadia Mono", "Cascadia Code", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((Math.round(hue * 10) / 10).toFixed(1) + '°', labelX, labelY);
    }

    // Footer: gap summary
    let minGap = Infinity, maxGap = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const here = sorted[i];
      const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
      const g = next - here;
      if (g < minGap) minGap = g;
      if (g > maxGap) maxGap = g;
    }
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 14px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const summary =
      'Min gap: ' + (Math.round(minGap * 10) / 10) + '°    ·    ' +
      'Max gap: ' + (Math.round(maxGap * 10) / 10) + '°    ·    ' +
      'Ideal even gap (10 hues): 36.0°';
    ctx.fillText(summary, WHEEL_CENTER_X, WHEEL_CENTER_Y + WHEEL_RADIUS_OUTER + 90);

    return c.toDataURL('image/png');
  })()`;

  const dataURL = await win.webContents.executeJavaScript(drawScript);
  const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = path.join(outDir, 'hue-simulation.png');
  fs.writeFileSync(file, png);
  console.log('wrote ' + file);

  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
