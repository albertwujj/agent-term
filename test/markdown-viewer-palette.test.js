const assert = require('assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
dom.window.matchMedia = dom.window.matchMedia || (() => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
}));
if (!dom.window.CSS) dom.window.CSS = { escape: (value) => value };

const { createMarkdownViewer } = require('../src/markdown-viewer');

const viewer = createMarkdownViewer({
  readMarkdownFile: async () => ({
    success: true,
    path: '/fake/palette.md',
    content: '# Palette\n\nBody text.',
  }),
  statMarkdownFile: async () => ({ success: true, mtimeMs: 1, size: 21 }),
  submitInlineComment() {},
  showToast() {},
  openURL() {},
  getTerminalMetrics: () => ({ top: 0, height: 384, rows: 24 }),
  openSearchBar() {},
  closeSearchBar() {},
  getSearchState: () => ({ isOpen: false }),
  onClose() {},
  platform: 'darwin',
});

const doubleClick = (element) => element.dispatchEvent(new window.MouseEvent('dblclick', {
  bubbles: true,
  cancelable: true,
}));

async function run() {
  await viewer.open({ filePath: '/fake/palette.md' });
  // Let the viewer's open-frame work start its refresh timer so close() below
  // can tear it down instead of racing a not-yet-run requestAnimationFrame.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const shell = document.querySelector('.vb-shell.vb-md');
  const bar = shell.querySelector('.vb-bar');

  assert.strictEqual(
    window.getComputedStyle(shell).getPropertyValue('--md-surface').trim(),
    '#dadde1',
  );

  doubleClick(bar);
  assert.ok(shell.classList.contains('vb-full'));
  assert.strictEqual(
    window.getComputedStyle(shell).getPropertyValue('--md-surface').trim(),
    '#eef1f5',
  );

  doubleClick(bar);
  assert.ok(!shell.classList.contains('vb-full'));
  assert.strictEqual(
    window.getComputedStyle(shell).getPropertyValue('--md-surface').trim(),
    '#dadde1',
  );

  viewer.close();
  console.log('markdown-viewer palette test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
