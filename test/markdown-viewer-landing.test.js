// Guards the jump-to-line "landing pulse": when the viewer lands on a requested
// line it flashes the resolved block in the live change-diff colour vocabulary
// (green = added, blue = deletion point, neutral otherwise), and a plain open
// with no target must NOT flash. The pulse reuses the md-change-pulse keyframes
// and the --exact/--anchor colours, so this test locks the coupling that would
// otherwise break silently under a rename or a landAt refactor.
//
// Mounts the REAL src/markdown-viewer.js in jsdom (mirrors integration.test.js).

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.requestAnimationFrame = dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => s };

const { createMarkdownViewer } = require('../src/markdown-viewer');

// Predictable 1-based source lines:
//  1 '# Heading' | 3 'Alpha ...' | 5 'Bravo ...' | 7 'Charlie ...'
const FIXTURE = [
  '# Heading',
  '',
  'Alpha paragraph, the added one.',
  '',
  'Bravo paragraph, near a deletion.',
  '',
  'Charlie context paragraph.',
  '',
  '## Delta section, styled',
  '',
  'Delta paragraph with **bold emphasis** and a `code span` in it.',
].join('\n');

const noop = () => {};
const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({ success: true, path: '/fake/doc.md', content: FIXTURE }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: FIXTURE.length }),
  submitInlineComment: noop,
  showToast: noop,
  openURL: noop,
  getTerminalMetrics: () => ({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }),
  openSearchBar: noop,
  closeSearchBar: noop,
  getSearchState: () => ({ isOpen: false }),
  onClose: noop,
  platform: 'darwin',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function landing(opts) {
  await viewer.open({ filePath: '/fake/doc.md', ...opts });
  await sleep(20); // let the open() rAF run landAt, plus the layout rAF
  const targets = Array.from(document.querySelectorAll('.md-landing-target'));
  const pulsed = Array.from(document.querySelectorAll('.md-landing-pulse'));
  const first = pulsed[0] || null;
  return {
    landedText: (targets[0] ? targets[0].textContent : '').trim(),
    targetCount: targets.length,
    pulseCount: pulsed.length,
    variant: first ? Array.from(first.classList).find((c) => /^md-landing-pulse--/.test(c)) : null,
  };
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`); }
}

async function run() {
  // Deleted line: renderer resolves it forward and asks for an 'anchor' landing.
  const del = await landing({ line: 5, matchText: 'Bravo paragraph, near a deletion.', landingKind: 'anchor' });
  check('deleted-line jump lands on the resolved block', del.landedText.includes('Bravo'), del);
  check('deleted-line flashes blue (anchor)', del.variant === 'md-landing-pulse--anchor', del);

  // Added line: 'exact'.
  const add = await landing({ line: 3, matchText: 'Alpha paragraph, the added one.', landingKind: 'exact' });
  check('added-line jump lands on the resolved block', add.landedText.includes('Alpha'), add);
  check('added-line flashes green (exact)', add.variant === 'md-landing-pulse--exact', add);

  // Context line: neutral.
  const ctx = await landing({ line: 7, matchText: 'Charlie context paragraph.', landingKind: 'neutral' });
  check('context-line flashes neutral', ctx.variant === 'md-landing-pulse--neutral', ctx);

  // A jump with no kind (e.g. a source-line / IDE nav) still flashes, defaulting neutral.
  const dflt = await landing({ line: 3, matchText: 'Alpha paragraph, the added one.' });
  check('kindless jump defaults to a neutral flash', dflt.variant === 'md-landing-pulse--neutral', dflt);

  // Plain open (no line, no text): a target is marked but nothing flashes.
  const plain = await landing({});
  check('plain open marks a target but does not flash', plain.pulseCount === 0 && plain.targetCount >= 1, plain);

  // matchText quoted from a terminal diff row is RAW markdown source. The
  // rendered text sheds the syntax (## on headings, ** around bold, backticks),
  // so these land via the source-text lookup, not the rendered-text scan.
  const rawHeading = await landing({ matchText: '## Delta section, styled' });
  check('raw-markdown heading matchText lands on the heading', rawHeading.landedText.includes('Delta section'), rawHeading);
  check('raw-markdown heading matchText flashes', rawHeading.pulseCount >= 1, rawHeading);

  const rawInline = await landing({ matchText: 'Delta paragraph with **bold emphasis** and a `code span` in it.' });
  check('raw-markdown inline-styled matchText lands on its paragraph', rawInline.landedText.includes('bold emphasis'), rawInline);

  // Rendered-prose quotes still land through the rendered-text scan.
  const rendered = await landing({ matchText: 'Bravo paragraph, near a deletion.' });
  check('plain prose matchText still lands', rendered.landedText.includes('Bravo'), rendered);

  // A matchText that exists nowhere: no flash, viewer falls back to the top.
  const miss = await landing({ matchText: 'text that is in no version of this doc' });
  check('missing matchText does not flash', miss.pulseCount === 0, miss);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
