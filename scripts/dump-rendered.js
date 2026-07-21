// Dumps the rendered script string from preview-taskbar-half-variants.js
// so we can spot any embedded-template issues.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'preview-taskbar-half-variants.js'), 'utf8');
// Pull out the renderScript function source by eval'ing the file in a sandbox.
// Easier: just call the function and write its output.
const m = require('module');
const sandbox = { module: { exports: {} }, require, console };
const wrapped = `(${src.replace(/^const\s+\{\s*app\s*,[^}]*\}\s*=\s*require\('electron'\);?/, '/* electron stripped */')})`;
// Actually just dynamic-load by extracting the function definition.
// Parse out renderScript function and call with mock data.
const SAMPLES = [{ idx: 0, prompt: 'Watch the build progress' }];
const VARIANTS = [{ id: 'n2-ul2', label: 'test' }];
const ICON_HUE_STEP = 24;
function firstLetterOf(prompt) {
  const idx = (prompt || '').search(/[A-Za-z]/);
  if (idx < 0) return { letter: '?', restFrom: 0 };
  return { letter: prompt[idx].toUpperCase(), restFrom: idx + 1 };
}
const sessions = SAMPLES.map(s => {
  const { letter, restFrom } = firstLetterOf(s.prompt);
  return { idx: s.idx, hue: 0, letter, rest: s.prompt.slice(restFrom), prompt: s.prompt };
});

// Now we need to extract the renderScript function. Let's just regex-find it.
const start = src.indexOf('function renderScript(');
const end = src.indexOf('\napp.whenReady', start);
const fnSrc = src.slice(start, end);
const fnFactory = new Function('OKLCH_L', 'OKLCH_C', 'ICON_HUE_STEP', 'FONT_PX', 'ICON_RX', 'return (' + fnSrc + ')');
const renderScript = fnFactory(65, 0.17, 24, 12, 6);
const result = renderScript(sessions, VARIANTS, 1);
fs.writeFileSync('/tmp/rendered-script.js', result);
console.log('Wrote /tmp/rendered-script.js', result.length, 'bytes');
