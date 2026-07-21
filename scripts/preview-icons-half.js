// Experiment — half-color, half-letter icon variant.
// Left half: solid hue. Right half: white background with the prompt's first
// alphabetic letter rendered in the same hue. Idea is that the icon carries
// both color identity AND the first letter of the prompt; the title-bar text
// would then start from the SECOND letter.
//
// Usage: npx electron scripts/preview-icons-half.js
// Output: ./icon-preview/half-{n}-{label}.png at 32x32 (real taskbar size)
//          and 256x256 (high-DPI / inspection)

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
  { idx: 7,  prompt: 'Implement the new endpoint' },
];

const ICON_HUE_STEP = 24;
const OKLCH_L = 65;
const OKLCH_C = 0.17;

// Strip leading non-letter chars (quotes, emoji like ✻, whitespace), then
// take the first alphabetic char. Returns { letter, restFrom } where
// restFrom is the index in the original prompt at which the "rest" of text
// begins (i.e., one past the first letter, leading punctuation discarded).
function firstLetterOf(prompt) {
  const idx = (prompt || '').search(/[A-Za-z]/);
  if (idx < 0) return { letter: '?', restFrom: 0 };
  return { letter: prompt[idx].toUpperCase(), restFrom: idx + 1 };
}

function renderScript(hue, letter, size) {
  const fill = `oklch(${OKLCH_L}% ${OKLCH_C} ${hue})`;
  return `(function(){
    const c = document.createElement('canvas');
    c.width = ${size}; c.height = ${size};
    const ctx = c.getContext('2d');
    const r = Math.round(${size} * 0.17);
    const inset = Math.round(${size} * 0.08);
    const w = ${size} - inset * 2;
    const h = ${size} - inset * 2;
    const x = inset, y = inset;

    function roundedRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // Only the LEFT half is filled — a colored chip. Right half is left
    // transparent so the taskbar's button background shows through, and the
    // letter floats next to the chip like the start of the button's text.
    ctx.save();
    roundedRectPath(x, y, w / 2, h, r);
    ctx.clip();
    ctx.fillStyle = ${JSON.stringify(fill)};
    ctx.fillRect(x, y, w / 2, h);
    // Subtle inset top highlight on the colored chip (matches existing icon).
    const hi = ctx.createLinearGradient(x, y, x, y + h * 0.35);
    hi.addColorStop(0, 'rgba(255,255,255,0.18)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hi;
    ctx.fillRect(x, y, w / 2, h * 0.35);
    ctx.restore();

    // Letter on the right half — light color (Windows taskbar text color)
    // in the taskbar's proportional font, so it reads as the start of the
    // button's text. Right half stays transparent.
    ctx.fillStyle = '#cccccc';
    ctx.font = '500 ' + Math.round(h * 0.5) + 'px "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(${JSON.stringify(letter)}, x + w * 0.75, y + h / 2 + h * 0.02);

    return c.toDataURL('image/png');
  })()`;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'icon-preview');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({ show: false, width: 400, height: 400 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  for (const s of SAMPLES) {
    const hue = (s.idx * ICON_HUE_STEP) % 360;
    const { letter, restFrom } = firstLetterOf(s.prompt);
    const rest = s.prompt.slice(restFrom);
    const slug = letter.toLowerCase();
    console.log(`  prompt="${s.prompt}"  -> letter=${letter}  rest="${rest}"`);
    for (const size of [32, 256]) {
      const dataURL = await win.webContents.executeJavaScript(renderScript(hue, letter, size));
      const png = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64');
      const file = path.join(outDir, `half-${String(s.idx).padStart(2,'0')}-${slug}-${size}.png`);
      fs.writeFileSync(file, png);
      console.log(`${s.idx} '${s.prompt}' → letter ${letter}, hue ${hue}, ${size}px`);
    }
  }

  console.log(`\nPreview folder: ${outDir}`);
  shell.openPath(outDir);
  win.destroy();
  app.quit();
});
