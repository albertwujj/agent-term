const assert = require('assert');
const {
  normalizeHttpUrl,
  createHttpUrlOpener,
} = require('../src/url-open');

async function run() {
  assert.strictEqual(normalizeHttpUrl('https://example.com'), 'https://example.com/');
  assert.strictEqual(normalizeHttpUrl('http://example.com/path?q=1'), 'http://example.com/path?q=1');
  assert.strictEqual(normalizeHttpUrl('file:///tmp/example'), null);
  assert.strictEqual(normalizeHttpUrl('not a url'), null);

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
