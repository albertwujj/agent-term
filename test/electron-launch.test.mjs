import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT_DIR, createElectronLauncher } from './e2e/electron.mjs';

test('a test opens on the checkout, wherever the run was started from', () => {
  assert.equal(CHECKOUT_DIR, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.equal(process.env.AGENT_TERM_START_CWD, CHECKOUT_DIR);
});

for (const service of ['com.apple.coreservices.launchservicesd', 'com.apple.windowserver.active']) {
  test(`a sandbox denial for ${service} prevents Electron from being spawned`, async () => {
    let launches = 0;
    const launch = createElectronLauncher({
      platform: 'darwin',
      readBlockedServices: () => [service],
      launch: () => { launches++; },
    });
    // --no-sandbox only affects Chromium; it cannot make this launch safe.
    await assert.rejects(launch({ args: ['--no-sandbox', '.'] }), error => {
      assert.equal(error.code, 'EMACOSSANDBOX');
      assert.ok(error.message.includes(service));
      assert.match(error.message, /Electron was not launched; no UI assertions ran/);
      assert.match(error.message, /Rerun the same test command/);
      return true;
    });
    assert.equal(launches, 0);
  });
}

test('an unavailable probe fails explicitly without attempting a GUI launch', async () => {
  const cause = new Error('native symbol unavailable');
  let launches = 0;
  const launch = createElectronLauncher({
    platform: 'darwin',
    readBlockedServices: () => { throw cause; },
    launch: () => { launches++; },
  });
  await assert.rejects(launch({}), error => {
    assert.equal(error.code, 'EGUIACCESSCHECK');
    assert.equal(error.cause, cause);
    assert.match(error.message, /native symbol unavailable/);
    return true;
  });
  assert.equal(launches, 0);
});

test('an allowed macOS launch preserves options and the Playwright application', async () => {
  const options = { args: ['--no-sandbox', '.'], env: { CODEX_CI: '1' }, timeout: 1234 };
  const app = {};
  const launch = createElectronLauncher({
    platform: 'darwin',
    readBlockedServices: () => [],
    launch: passed => { assert.equal(passed, options); return app; },
  });
  assert.equal(await launch(options), app);
});

for (const platform of ['linux', 'win32']) {
  test(`${platform} launches without loading the macOS probe`, async () => {
    const app = {};
    const launch = createElectronLauncher({
      platform,
      readBlockedServices: () => { assert.fail('macOS probe must not run'); },
      launch: () => app,
    });
    assert.equal(await launch({}), app);
  });
}

test('a Linux launch has no window, so no keystroke from the desktop can reach it', async () => {
  let passed;
  const launch = createElectronLauncher({ platform: 'linux', launch: (options) => { passed = options; } });
  await launch({ args: ['--no-sandbox', '.'], timeout: 1234 });
  assert.ok(passed.args.includes('--ozone-platform=headless'), passed.args.join(' '));
  assert.deepEqual(passed.args.slice(-2), ['--no-sandbox', '.']);
  assert.equal(passed.timeout, 1234);
});

test('a Linux launch has WebGL unless the test asked for no GPU', async () => {
  let passed;
  const launch = createElectronLauncher({ platform: 'linux', launch: (options) => { passed = options; } });
  await launch({ args: ['.'] });
  assert.ok(passed.args.includes('--use-angle=swiftshader'), passed.args.join(' '));
  await launch({ args: ['--disable-gpu', '.'] });
  assert.ok(!passed.args.includes('--use-angle=swiftshader'), passed.args.join(' '));
});

test('AGENT_TERM_E2E_WINDOW shows the window, to watch a run', async () => {
  let passed;
  const options = { args: ['.'] };
  const launch = createElectronLauncher({ platform: 'linux', launch: (received) => { passed = received; } });
  process.env.AGENT_TERM_E2E_WINDOW = '1';
  try { await launch(options); } finally { delete process.env.AGENT_TERM_E2E_WINDOW; }
  assert.equal(passed, options);
});

test('a real launch failure is preserved instead of being reported as a sandbox denial', async () => {
  const failure = new Error('Playwright failed to connect');
  const launch = createElectronLauncher({
    platform: 'darwin',
    readBlockedServices: () => [],
    launch: async () => { throw failure; },
  });
  await assert.rejects(launch({}), error => error === failure);
});
