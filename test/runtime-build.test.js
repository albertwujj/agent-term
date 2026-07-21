const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rebuildRuntimeBundles } = require('../src/runtime-build');

let testsPassed = 0, testsFailed = 0;

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

console.log('runtime-build');

test('removes both stale artifacts before rebuilding every runtime bundle', () => {
  const events = [];
  const fakeFs = {
    mkdirSync(dir, options) { events.push(['mkdir', dir, options]); },
    rmSync(file, options) { events.push(['remove', file, options]); },
  };
  const fakeEsbuild = {
    buildSync(options) { events.push(['build', options]); },
  };
  const srcDir = path.join('/repo', 'src');
  const distDir = path.join('/repo', 'dist');

  const outputs = rebuildRuntimeBundles({
    esbuild: fakeEsbuild,
    fs: fakeFs,
    srcDir,
    distDir,
  });

  assert.deepStrictEqual(outputs, [
    path.join(distDir, 'renderer.js'),
    path.join(distDir, 'web-viewer-preload.js'),
  ]);
  assert.deepStrictEqual(events.map((event) => event[0]), [
    'mkdir', 'remove', 'remove', 'build', 'build',
  ]);

  const builds = events.filter((event) => event[0] === 'build').map((event) => event[1]);
  assert.deepStrictEqual(builds[0], {
    entryPoints: [path.join(srcDir, 'renderer.js')],
    bundle: true,
    outfile: path.join(distDir, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
  });
  assert.deepStrictEqual(builds[1], {
    entryPoints: [path.join(srcDir, 'web-viewer-preload.js')],
    bundle: true,
    outfile: path.join(distDir, 'web-viewer-preload.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
});

test('a failed build leaves no stale runtime artifact to fall back to', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-runtime-build-'));
  const srcDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(distDir);
  const outputs = [
    path.join(distDir, 'renderer.js'),
    path.join(distDir, 'web-viewer-preload.js'),
  ];
  for (const output of outputs) fs.writeFileSync(output, 'old code');

  try {
    assert.throws(
      () => rebuildRuntimeBundles({
        esbuild: { buildSync() { throw new Error('synthetic build failure'); } },
        fs,
        srcDir,
        distDir,
      }),
      /synthetic build failure/,
    );
    for (const output of outputs) assert.strictEqual(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second-bundle failure cannot leave the old preload beside a new renderer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-runtime-build-'));
  const srcDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(distDir);
  const rendererOut = path.join(distDir, 'renderer.js');
  const preloadOut = path.join(distDir, 'web-viewer-preload.js');
  fs.writeFileSync(rendererOut, 'old renderer');
  fs.writeFileSync(preloadOut, 'old preload');

  try {
    let buildCount = 0;
    assert.throws(
      () => rebuildRuntimeBundles({
        esbuild: {
          buildSync(options) {
            buildCount++;
            if (buildCount === 2) throw new Error('synthetic preload failure');
            fs.writeFileSync(options.outfile, 'new renderer');
          },
        },
        fs,
        srcDir,
        distDir,
      }),
      /synthetic preload failure/,
    );
    assert.strictEqual(fs.readFileSync(rendererOut, 'utf8'), 'new renderer');
    assert.strictEqual(fs.existsSync(preloadOut), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
