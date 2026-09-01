const assert = require('assert');
const {
  normalizeHttpUrl,
  createHttpUrlOpener,
  urlClickWantsExternal,
} = require('../src/url-open');

async function run() {
  assert.strictEqual(normalizeHttpUrl('https://example.com'), 'https://example.com/');
  assert.strictEqual(normalizeHttpUrl('http://example.com/path?q=1'), 'http://example.com/path?q=1');
  assert.strictEqual(normalizeHttpUrl('file:///tmp/example'), null);
  assert.strictEqual(normalizeHttpUrl('not a url'), null);

  // A web URL: plain click → system browser, Ctrl/Cmd/Alt → embedded band.
  assert.strictEqual(urlClickWantsExternal('https://example.com', {}), true);
  assert.strictEqual(urlClickWantsExternal('https://example.com', null), true);
  assert.strictEqual(urlClickWantsExternal('https://example.com', { shiftKey: true }), true);
  assert.strictEqual(urlClickWantsExternal('http://example.com', { metaKey: true }), false);
  assert.strictEqual(urlClickWantsExternal('https://example.com', { ctrlKey: true }), false);
  assert.strictEqual(urlClickWantsExternal('https://example.com', { altKey: true }), false);
  // A local page: plain click → band, modifier → OS handler. review:// is
  // routed in-app before the verdict matters.
  assert.strictEqual(urlClickWantsExternal('file:///tmp/page.html', {}), false);
  assert.strictEqual(urlClickWantsExternal('file:///tmp/page.html', { metaKey: true }), true);
  assert.strictEqual(urlClickWantsExternal('review:///tmp/pkg.md', {}), false);

  const opened = [];
  const openHttpUrl = createHttpUrlOpener({
    openURL: async (url) => opened.push(url),
  });

  assert.strictEqual(await openHttpUrl('https://example.com', 'visible-url'), true);
  assert.deepStrictEqual(opened, ['https://example.com/']);

  assert.strictEqual(await openHttpUrl('https://example.org', 'osc8'), true);
  assert.deepStrictEqual(opened, ['https://example.com/', 'https://example.org/']);

  assert.strictEqual(await openHttpUrl('ftp://example.com/file', 'osc8'), false);
  assert.strictEqual(await openHttpUrl('not a url', 'osc8'), false);
  assert.deepStrictEqual(opened, ['https://example.com/', 'https://example.org/']);

  const failedLogs = [];
  const failingOpenHttpUrl = createHttpUrlOpener({
    openURL: async () => { throw new Error('browser unavailable'); },
    log: (message) => failedLogs.push(message),
  });
  assert.strictEqual(await failingOpenHttpUrl('https://failure.example', 'osc8'), false);
  assert.match(failedLogs[0], /failed osc8: https:\/\/failure\.example\/: browser unavailable/);
}

run().then(() => {
  console.log('url-open tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
