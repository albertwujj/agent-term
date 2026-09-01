// Tests for src/atomic-file.js — two writers replacing one file never share a temp path.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomicSync, writeFileAtomic } = require('../src/atomic-file');

let testsPassed = 0, testsFailed = 0;

async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-atomic-test-'));
  try {
    await fn(dir);
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('atomic-file');

(async () => {
  await test('writeFileAtomicSync replaces the file and leaves no temp behind', (dir) => {
    const file = path.join(dir, 'rec.json');
    writeFileAtomicSync(file, 'one');
    writeFileAtomicSync(file, 'two');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepStrictEqual(fs.readdirSync(dir), ['rec.json']);
  });

  await test('a failed write cleans up its temp file and rethrows', (dir) => {
    const target = path.join(dir, 'taken');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'x'), '');
    let err = null;
    try { writeFileAtomicSync(target, 'a'); } catch (e) { err = e; }
    assert.ok(err, 'expected the rename over a non-empty directory to throw');
    assert.deepStrictEqual(fs.readdirSync(dir), ['taken']);
  });

  await test('two processes writing the same file concurrently both succeed', (dir) => {
    // Simulates the two-window heartbeat: each writer takes its own temp path,
    // so the second rename never looks for a temp the first one moved away.
    const file = path.join(dir, 'shared.json');
    const script = `
      const { writeFileAtomicSync } = require(${JSON.stringify(path.resolve(__dirname, '../src/atomic-file.js'))});
      for (let i = 0; i < 200; i++) writeFileAtomicSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, i }));
    `;
    const { spawnSync } = require('child_process');
    const a = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const b = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 0, b.stderr);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).i === 199);
    assert.deepStrictEqual(fs.readdirSync(dir), ['shared.json']);
  });

  await test('writeFileAtomic (async) replaces the file', async (dir) => {
    const file = path.join(dir, 'doc.md');
    await writeFileAtomic(file, '# one\n', 'utf8');
    await writeFileAtomic(file, '# two\n', 'utf8');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# two\n');
    assert.deepStrictEqual(fs.readdirSync(dir), ['doc.md']);
  });

  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
})();
