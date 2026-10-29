const assert = require('assert');
const {
  opensExternally,
  handoffLabel,
  normalizeHttpUrl,
  createHttpUrlOpener,
  urlClickWantsExternal,
} = require('../src/url-open');

async function run() {
  // What the window says while the other app comes forward.
  assert.strictEqual(handoffLabel('mailto:alex.doe@example.com'), 'Opening in mail app…');
  assert.strictEqual(handoffLabel('https://example.com/x'), 'Opening in browser…');
  assert.strictEqual(handoffLabel('file:///tmp/My%20Notes.html'), 'Opening My Notes.html…');
  assert.strictEqual(handoffLabel('/home/me/out/report.docx'), 'Opening report.docx…');
  assert.strictEqual(handoffLabel('/home/me/src/components/'), 'Opening components…');
  assert.strictEqual(handoffLabel('\\\\wsl.localhost\\Ubuntu\\home\\me\\bundle.zip'), 'Opening bundle.zip…');
  assert.strictEqual(handoffLabel(''), 'Opening…');

  // The schemes main hands to the OS: web and local pages, and a mail draft.
  assert.strictEqual(opensExternally('https://example.com'), true);
  assert.strictEqual(opensExternally('file:///tmp/page.html'), true);
  assert.strictEqual(opensExternally('mailto:alex.doe@example.com'), true);
  assert.strictEqual(opensExternally('MAILTO:alex.doe@example.com'), true);
  assert.strictEqual(opensExternally('ms-settings:privacy'), false);
  assert.strictEqual(opensExternally('javascript:alert(1)'), false);
  assert.strictEqual(opensExternally(' mailto:alex.doe@example.com'), false);
  assert.strictEqual(opensExternally(undefined), false);

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
