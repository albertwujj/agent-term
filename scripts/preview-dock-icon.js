// Visual preview for the macOS Dock tile (src/icon-render dockIconScript).
//
// Renders icon-preview/dock-tile-grid.png: every hue of the rotation with a
// sample prompt, plus the app tile and the pre-prompt brand tiles, each at Dock size (64pt on
// a Retina display = 128px) on a light and a dark Dock strip, and one tile at
// the full 512px canvas. Checks: white letters read on every hue (the
// yellow-green band is the weakest), the brand glyphs read on the neutral
// tile, and the tile matches the size of a neighbouring app icon.
//
// Run: electron scripts/preview-dock-icon.js
//
// Production parity: the tile script comes from ../src/icon-render, the
// brand SVG from ../src/cli-icons — the same pair main.js uses.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { dockIconScript, dockLetterCandidates, DOCK_ICON_PX } = require('../src/icon-render');
const cliIcons = require('../src/cli-icons');

const ICON_HUE_STEP = 24;
const PROMPTS = [
  'Migrate the database schema',
  'Investigate the flaky login test',
  'Write the auth middleware tests',
  'Pay attention to the queue depth',
  'Quickly check the deployment',
  '"please fix the syntax issue"',
  'Up',
  'Illustrate the release flow',
  'Add a Dock icon per session',
  'Refactor the stream client',
  'Why does the tunnel flap',
  'Explain the lock warnings',
  'Generate the changelog',
  'In case the build fails',
  'I hit a wall with the tunnel',
];

function gridScript() {
  const tiles = PROMPTS.map((prompt, idx) => ({
    label: `${(idx * ICON_HUE_STEP) % 360}°`,
    script: dockIconScript({ hue: (idx * ICON_HUE_STEP) % 360, letterCandidates: dockLetterCandidates(prompt) }),
  }));
  tiles.push({ label: 'app', script: dockIconScript() });
  for (const cli of ['claude', 'codex', 'copilot', 'agent']) {
    tiles.push({ label: cli, script: dockIconScript({ brandSvg: cliIcons.iconSvg(cli, 256, '#ffffff') }) });
  }
  tiles.push({ label: 'no letters', script: dockIconScript({ hue: 96, letterCandidates: dockLetterCandidates('') }) });
  return `(async function(){
    const tiles = ${JSON.stringify(tiles)};
    const DOCK = 128;                 // 64pt @2x
    const GAP = 12;
    const COLS = 10;
    const rows = Math.ceil(tiles.length / COLS);
    const stripH = DOCK + 2 * GAP;
    const W = COLS * (DOCK + GAP) + GAP;
    const FULL = ${DOCK_ICON_PX};
    const H = rows * stripH * 2 + 40 + FULL + 40;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#7d8aa3';        // wallpaper-ish ground behind the strips
    ctx.fillRect(0, 0, W, H);
    const imgs = [];
    for (const t of tiles) {
      const r = JSON.parse(await eval(t.script));
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = r.url; });
      imgs.push(img);
    }
    function strip(y, bg, labelColor) {
      for (let row = 0; row < rows; row++) {
        const top = y + row * stripH;
        ctx.fillStyle = bg;
        ctx.fillRect(0, top, W, stripH);
        for (let col = 0; col < COLS; col++) {
          const i = row * COLS + col;
          if (i >= tiles.length) break;
          const x = GAP + col * (DOCK + GAP);
          ctx.drawImage(imgs[i], x, top + GAP, DOCK, DOCK);
          ctx.fillStyle = labelColor;
          ctx.font = '500 11px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(tiles[i].label, x + DOCK / 2, top + GAP + DOCK - 2);
        }
      }
    }
    strip(0, 'rgba(235,235,238,0.92)', '#333');
    strip(rows * stripH, 'rgba(40,40,44,0.92)', '#ddd');
    const fy = rows * stripH * 2 + 40;
    ctx.drawImage(imgs[0], GAP, fy, FULL, FULL);
    ctx.drawImage(imgs[tiles.length - 5], GAP * 2 + FULL, fy, FULL, FULL);
    return out.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const url = await win.webContents.executeJavaScript(gridScript());
  const png = Buffer.from(url.split(',')[1], 'base64');
  const file = path.join(__dirname, '..', 'icon-preview', 'dock-tile-grid.png');
  fs.writeFileSync(file, png);
  console.log('wrote', file);
  app.quit();
});
