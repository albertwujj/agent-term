const assert = require('assert');
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

test('installs Electron before applying the node-pty permission fix', () => {
  const calls = [];
  runPostinstall({
    nodePath: 'node-test',
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
});

test('stops before the permission fix when Electron installation fails', () => {
  let loaded = false;
  assert.throws(
    () => runPostinstall({
      resolve: () => 'electron-install-test.js',
      spawn: () => ({ status: 7 }),
      load: () => { loaded = true; },
    }),
    /Electron installation failed with exit code 7/,
  );
  assert.strictEqual(loaded, false);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
