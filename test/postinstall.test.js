const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { runPostinstall } = require('../scripts/postinstall');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('postinstall');

test('locked dependency install scripts have explicit version approvals', () => {
  const manifest = require('../package.json');
  const lock = require('../package-lock.json');
  const scripted = Object.entries(lock.packages)
    .filter(([name, pkg]) => name && pkg.hasInstallScript)
    .map(([name, pkg]) => `${name.split('node_modules/').pop()}@${pkg.version}`)
    .sort();
  const approvals = manifest.allowScripts || {};
  assert.deepStrictEqual(Object.keys(approvals).sort(), scripted,
    'review changed dependency install scripts and update their version approvals');
  for (const name of scripted) assert.strictEqual(approvals[name], true, name);
});

test('Windows postinstall skips POSIX permissions and still stamps dependencies', () => {
  const entry = JSON.stringify(path.join(__dirname, '..', 'scripts', 'postinstall.js'));
  const install = spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    require('fs').chmodSync = () => { throw new Error('Windows must not chmod'); };
    require(${entry}).runPostinstall({
      resolve: () => 'electron-install-test.js',
      spawn: () => ({ status: 0 }),
      stamp: () => console.log('stamped'),
    });
  `], { encoding: 'utf8' });
  assert.strictEqual(install.status, 0, install.stderr);
  assert.strictEqual(install.stdout.trim(), 'stamped');
  assert.strictEqual(install.stderr, '');
});

test('installs Electron before applying the node-pty permission fix', () => {
  const calls = [];
  runPostinstall({
    nodePath: 'node-test',
    stamp: () => calls.push(['stamp']),
    resolve: (request) => {
      assert.strictEqual(request, 'electron/install.js');
      return 'electron-install-test.js';
    },
    spawn: (command, args, options) => {
      calls.push(['spawn', command, args, options]);
      return { status: 0 };
    },
    load: (request) => calls.push(['load', request]),
  });

  assert.deepStrictEqual(calls[0].slice(0, 3), [
    'spawn',
    'node-test',
    ['electron-install-test.js'],
  ]);
  assert.strictEqual(calls[0][3].stdio, 'inherit');
  assert.deepStrictEqual(calls[1], ['load', './fix-pty-perms']);
  assert.deepStrictEqual(calls[2], ['stamp'], 'the tree is stamped after it is installed');
});

test('stops before the permission fix when Electron installation fails', () => {
  let loaded = false;
  assert.throws(
    () => runPostinstall({
      stamp: () => { throw new Error('stamp must not run'); },
      resolve: () => 'electron-install-test.js',
      spawn: () => ({ status: 7 }),
      load: () => { loaded = true; },
    }),
    /Electron installation failed with exit code 7/,
  );
  assert.strictEqual(loaded, false);
});

test('a stamp failure warns but does not fail the install', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    runPostinstall({
      resolve: () => 'electron-install-test.js',
      spawn: () => ({ status: 0 }),
      load: () => {},
      stamp: () => { throw new Error('node_modules is read-only'); },
    });
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('node_modules is read-only'));
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
