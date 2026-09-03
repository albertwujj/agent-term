// Tests for src/icon-render.js — pure JS helpers, runs in Node.

const assert = require('assert');
const { truncatePathsForTaskbar, extractPathsAndUrls, dockIconScript, dockLetterCandidates, letterCandidates, pickerIconScript } = require('../src/icon-render');

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

console.log('icon-render');

// ---- truncatePathsForTaskbar — URLs ----

test('URL with a numeric leaf keeps the whole distinctive identifier', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Review https://github.com/owner/repo/issues/42'),
    'Review 42'
  );
});

test('Multiple URLs each shortened independently', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Compare https://a.com/x/y and https://b.org/z'),
    'Compare …y and …z'
  );
});

test('URL without path drops scheme and suffix', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Visit https://example.com'),
    'Visit example'
  );
});

test('URL with bare trailing slash drops scheme, suffix, and slash', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Visit https://example.com/'),
    'Visit example'
  );
});

test('http (no s) URL also keeps last two path chars', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Check http://localhost:8080/api/foo'),
    'Check …oo'
  );
});

test('Subdomain URL with path keeps last two path chars', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Read https://docs.github.com/foo/bar'),
    'Read …ar'
  );
});

test('GitHub PR URL keeps the whole PR number', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Review https://github.com/owner/repo/pull/1234'),
    'Review 1234'
  );
});

test('workflow invocation uses the Gerrit change number as taskbar identity', () => {
  const prompt = '@ai/gerrit/pr-review.md https://gerrit.ext.net.nokia.com/gerrit/c/ENET/Eden-NET/+/10427036';
  const result = extractPathsAndUrls(prompt);
  assert.strictEqual(result.text, '10427036');
  assert.deepStrictEqual(letterCandidates(result.text), ['1042', '104', '10']);
  assert.deepStrictEqual(result.refs, [
    { kind: 'url', full: 'https://gerrit.ext.net.nokia.com/gerrit/c/ENET/Eden-NET/+/10427036' },
    { kind: 'mention', full: '@ai/gerrit/pr-review.md' },
  ]);
});

// ---- truncatePathsForTaskbar — file paths ----

test('Deep unix path → filename stem', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Edit /home/yunxin/agent-term/src/main.js'),
    'Edit main'
  );
});

test('Filename extension stripped', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Open /usr/local/lib/python3/foo.py for me'),
    'Open foo for me'
  );
});

test('Tilde path → filename stem', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Look at ~/projects/foo/bar.py'),
    'Look at bar'
  );
});

test('Relative path with directory → filename stem', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Fix src/renderer/main.js'),
    'Fix main'
  );
});

test('Short absolute path keeps only basename', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Fix /etc/hosts'),
    'Fix hosts'
  );
});

test('Directory with trailing slash keeps basename and slash', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('cd /usr/local/bin/'),
    'cd bin/'
  );
});

test('Path at start of string is shortened', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('/home/yunxin/agent-term/file.txt'),
    'file'
  );
});

test('Filename without extension still preserved', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('chmod /home/yunxin/scripts/Makefile'),
    'chmod Makefile'
  );
});

// ---- truncatePathsForTaskbar — no-ops and mixed ----

test('Plain prompt with no URL or path is untouched', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Fix the auth bug in login.py'),
    'Fix the auth bug in login.py'
  );
});

test('URL and path in same prompt', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('See https://docs.foo/guide/intro and /home/me/agent-term/src/x.js'),
    'See …ro and x'
  );
});

test('Slash inside a URL is not double-shortened', () => {
  // URL shortening runs before path shortening and leaves no slash behind.
  assert.strictEqual(
    truncatePathsForTaskbar('Read https://github.com/foo/bar.md'),
    'Read …ar'
  );
});

test('@ file mention drops marker, scope, and extension', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Read @ai/build-api-guide.md'),
    'Read build-api-guide'
  );
});

test('extractPathsAndUrls keeps original refs while compacting display', () => {
  const result = extractPathsAndUrls('See https://github.com/y/x and @ai/guide.md and /tmp/work/main.js');
  assert.strictEqual(result.text, 'See …x and guide and main');
  assert.deepStrictEqual(result.refs, [
    { kind: 'url', full: 'https://github.com/y/x' },
    { kind: 'path', full: '/tmp/work/main.js' },
    { kind: 'mention', full: '@ai/guide.md' },
  ]);
});

test('Dotfile basename is preserved', () => {
  assert.strictEqual(
    truncatePathsForTaskbar('Edit /home/me/project/.env'),
    'Edit .env'
  );
});

test('Empty / null / non-string input normalised to empty string', () => {
  // Call sites concatenate the result into rendered strings (chrome bar,
  // thumbnail card), so non-string passthrough would produce literal
  // "null" / "undefined" / "42" in the UI. Normalise to '' instead.
  assert.strictEqual(truncatePathsForTaskbar(''), '');
  assert.strictEqual(truncatePathsForTaskbar(null), '');
  assert.strictEqual(truncatePathsForTaskbar(undefined), '');
  assert.strictEqual(truncatePathsForTaskbar(42), '');
});

// ---- dockIconScript — macOS Dock tile ----

test('dock tile with no hue and no brand glyph is the app tile: session rows on the neutral fill', () => {
  const script = dockIconScript();
  assert.ok(script.includes('oklch(40% 0.012 260)'));
  assert.ok(script.includes('rows: true'));
  for (const hue of [336, 192, 72]) assert.ok(script.includes(`oklch(65% 0.27 ${hue})`));
  assert.ok(!script.includes('oklch(69%'));
});

test('windows picker icon draws the same session rows on a transparent 256px canvas', () => {
  const script = pickerIconScript();
  assert.ok(script.includes('const C = 256'));
  assert.ok(script.includes('rows: true'));
  for (const hue of [336, 192, 72]) assert.ok(script.includes(`oklch(65% 0.27 ${hue})`));
  assert.ok(!script.includes('oklch(40% 0.012 260)'));
});

test('dock letter candidates never end in whitespace or a lone letter of a new word', () => {
  assert.deepStrictEqual(dockLetterCandidates('In case the build fails'), ['In', 'In', 'In']);
  assert.deepStrictEqual(dockLetterCandidates('I hit a wall'), ['I hi', 'I', 'I']);
  assert.deepStrictEqual(dockLetterCandidates('Why does the tunnel flap'), ['Why', 'Why', 'Wh']);
  assert.deepStrictEqual(dockLetterCandidates("I'd like a review"), ["I'd ", "I'd", "I'"].map(c => c.trimEnd()));
  assert.deepStrictEqual(dockLetterCandidates('Migrate the schema'), ['Migr', 'Mig', 'Mi']);
});

test('dock tile with a hue paints that hue and carries the letter candidates', () => {
  const script = dockIconScript({ hue: 48, letterCandidates: letterCandidates('Migrate the schema') });
  assert.ok(script.includes('oklch(69% 0.27 48)'));
  assert.ok(script.includes('["Migr","Mig","Mi"]'));
});

test('dock tile with a brand glyph uses the neutral fill and embeds the svg', () => {
  const script = dockIconScript({ brandSvg: '<svg id="brand"/>' });
  assert.ok(script.includes('oklch(40% 0.012 260)'));
  assert.ok(script.includes('<svg id=\\"brand\\"/>'));
  assert.ok(!script.includes('oklch(69%'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
