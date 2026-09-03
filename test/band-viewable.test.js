const assert = require('assert');
const {
  BAND_VIEWABLE_KINDS,
  BAND_FILE_EXTENSIONS,
  BAND_FILE_TARGET,
  DISK_SEARCH_EXTENSIONS,
  bandViewableKind,
  isBandFilePath,
} = require('../src/band-viewable');

let testsPassed = 0;
let testsFailed = 0;
function test(name, fn) {
  try { fn(); testsPassed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('band-viewable');

test('every kind the band renders resolves from a path, a URL, or a Windows path', () => {
  assert.strictEqual(bandViewableKind('docs/plan.md'), 'md');
  assert.strictEqual(bandViewableKind('/tmp/report.HTML'), 'html');
  assert.strictEqual(bandViewableKind('shot.png'), 'image');
  assert.strictEqual(bandViewableKind('~/launch/hero.mp4'), 'video');
  assert.strictEqual(bandViewableKind('take.flac'), 'audio');
  assert.strictEqual(bandViewableKind('file:///Users/u/paper.pdf'), 'pdf');
  assert.strictEqual(bandViewableKind('file:///Users/u/paper.pdf#page=2'), 'pdf');
  assert.strictEqual(bandViewableKind('\\\\wsl.localhost\\Ubuntu\\home\\clip.webm'), 'video');
});

test('a # or ? in a bare path is part of the name, not a fragment', () => {
  assert.strictEqual(bandViewableKind('/tmp/notes #2.md'), 'md');
});

test('what the band cannot render is null', () => {
  for (const p of ['bundle.zip', 'clip.mov', 'clip.avi', 'deck.pptx', 'src/a.js', 'README', 'https://a.com/x']) {
    assert.strictEqual(bandViewableKind(p), null, p);
  }
});

test('the file route serves images, video, audio and pdf; md and html have routes of their own', () => {
  assert.ok(isBandFilePath('a.png') && isBandFilePath('a.mp4') && isBandFilePath('a.mp3') && isBandFilePath('a.pdf'));
  assert.ok(!isBandFilePath('a.md') && !isBandFilePath('a.html') && !isBandFilePath('a.zip') && !isBandFilePath('a.mov'));
  assert.ok(BAND_FILE_EXTENSIONS.includes('mkv') && !BAND_FILE_EXTENSIONS.includes('md'));
});

test('the click-rule target sees the extension through a qualifier and a trailing comma', () => {
  assert.ok(BAND_FILE_TARGET.test('shot.png:1'));
  assert.ok(BAND_FILE_TARGET.test('see clip.mp4,'));
  assert.ok(BAND_FILE_TARGET.test('paper.pdf'));
  assert.ok(!BAND_FILE_TARGET.test('bundle.zip'));
  assert.ok(!BAND_FILE_TARGET.test('clip.mp4x'));
});

test('the disk walk lists every kind, dotted', () => {
  const all = Object.values(BAND_VIEWABLE_KINDS).flat();
  assert.strictEqual(DISK_SEARCH_EXTENSIONS.length, all.length);
  assert.ok(DISK_SEARCH_EXTENSIONS.every((e) => e.startsWith('.')));
  assert.ok(DISK_SEARCH_EXTENSIONS.includes('.md') && DISK_SEARCH_EXTENSIONS.includes('.pdf'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
