// Structured prompt attachments belong only to the full live-preview
// reference rows. Legacy prompt events stay text-only without inference.

const assert = require('assert');
const { imageAttachmentRefs, buildLivePreviewScript } = require('../src/prompt-thumbnail');

const imagePath = '/mnt/c/Users/me/AppData/Local/Temp/clipboard-123.png';
const refs = imageAttachmentRefs([
  { prompt: '/tmp/clipboard-old.pngLegacy prompt' },
  { prompt: 'Review this', attachments: [{ kind: 'image', path: imagePath }] },
  { prompt: 'Same image again', attachments: [{ kind: 'image', path: imagePath }] },
]);

assert.deepStrictEqual(refs, [{ kind: 'image', full: `image · ${imagePath}` }]);

const script = buildLivePreviewScript({
  width: 1280,
  height: 720,
  firstPrompt: 'Review this',
  refs,
});
assert.ok(script.includes(imagePath), 'full live preview carries the image reference');

console.log('prompt-thumbnail: 2 passed');
