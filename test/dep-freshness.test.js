const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { stampPath, lockPath, writeLockStamp, dependencyProblem, missingDependencies } = require('../src/dep-freshness');

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

const ROOT = path.join('/repo');

// Files are addressed by path, so the fake keeps mtimes out of it entirely:
// the point of the module is that content decides, not timestamps.
function fakeFs(files) {
  return {
    written: {},
    readFileSync(file) {
      if (!(file in files)) {
        const err = new Error(`ENOENT: ${file}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[file];
    },
    writeFileSync(file, data) { this.written[file] = data; files[file] = data; },
  };
}

console.log('dep-freshness');

test('a tree stamped from the current lockfile reports no problem', () => {
  const files = { [lockPath(ROOT)]: '{"lockfileVersion":3}' };
  const fs = fakeFs(files);
  writeLockStamp({ fs, crypto, root: ROOT });
  assert.strictEqual(dependencyProblem({ fs, crypto, root: ROOT }), null);
});

test('a lockfile edited after the install reports a problem naming the fix', () => {
  const files = { [lockPath(ROOT)]: '{"lockfileVersion":3}' };
  const fs = fakeFs(files);
  writeLockStamp({ fs, crypto, root: ROOT });
  files[lockPath(ROOT)] = '{"lockfileVersion":3,"packages":{"node_modules/new":{}}}';
  const problem = dependencyProblem({ fs, crypto, root: ROOT });
  assert.ok(problem, 'expected a problem');
  assert.ok(problem.includes('package-lock.json'), 'names the file that changed');
  assert.ok(problem.includes('npm ci'), 'names the fix');
  assert.ok(!/\n/.test(problem), 'one line: it is printed into the terminal');
});

test('rewriting the lockfile with identical content is not a problem', () => {
  const files = { [lockPath(ROOT)]: '{"lockfileVersion":3}' };
  const fs = fakeFs(files);
  writeLockStamp({ fs, crypto, root: ROOT });
  // What a branch switch does: same bytes, new timestamp. An mtime check would
  // abort here, which is why this module never looks at one.
  files[lockPath(ROOT)] = '{"lockfileVersion":3}';
  assert.strictEqual(dependencyProblem({ fs, crypto, root: ROOT }), null);
});

test('a package declared but not installed is reported, so it can stop the start', () => {
  const files = {
    [path.join(ROOT, 'package.json')]: JSON.stringify({
      dependencies: { present: '1.0.0', gone: '2.0.0' },
      devDependencies: { alsoPresent: '3.0.0' },
    }),
  };
  const fs = fakeFs(files);
  fs.existsSync = (f) => !f.endsWith(path.join('node_modules', 'gone'));
  assert.deepStrictEqual(missingDependencies({ fs, root: ROOT }), ['gone']);
});

test('a fully installed tree reports nothing missing, whatever the lockfile says', () => {
  const files = {
    [path.join(ROOT, 'package.json')]: JSON.stringify({ dependencies: { a: '1', b: '2' } }),
  };
  const fs = fakeFs(files);
  fs.existsSync = () => true;
  assert.deepStrictEqual(missingDependencies({ fs, root: ROOT }), []);
});

test('an unreadable package.json blocks nothing', () => {
  const fs = fakeFs({});
  fs.existsSync = () => false;
  assert.deepStrictEqual(missingDependencies({ fs, root: ROOT }), []);
});

test('a tree that was never stamped stays quiet', () => {
  const fs = fakeFs({ [lockPath(ROOT)]: '{"lockfileVersion":3}' });
  assert.strictEqual(dependencyProblem({ fs, crypto, root: ROOT }), null);
});

test('a checkout with no lockfile stays quiet', () => {
  const fs = fakeFs({ [stampPath(ROOT)]: 'deadbeef\n' });
  assert.strictEqual(dependencyProblem({ fs, crypto, root: ROOT }), null);
});

test('the stamp is written inside node_modules, where an install replaces it', () => {
  const files = { [lockPath(ROOT)]: '{}' };
  const fs = fakeFs(files);
  writeLockStamp({ fs, crypto, root: ROOT });
  const written = Object.keys(fs.written);
  assert.deepStrictEqual(written, [stampPath(ROOT)]);
  assert.ok(written[0].includes('node_modules'), 'stamp lives with the tree it describes');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
