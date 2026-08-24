const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUNTIME_ENTRIES, stageSource } = require('../scripts/windows-dev-bootstrap');

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

console.log('windows-dev-bootstrap');

test('stages only runtime source beneath a process-specific directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  const runner = path.join(root, 'runner');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(source, 'node_modules', 'linux-only'), { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v1');
    fs.writeFileSync(path.join(source, 'tools', 'review.py'), 'review-v1');
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.2.3"}');
    fs.writeFileSync(path.join(source, 'node_modules', 'linux-only', 'binding.node'), 'linux');

    const staged = stageSource(source, runner, 1234);
    assert.strictEqual(staged, path.join(runner, 'stage', '1234'));
    assert.strictEqual(fs.readFileSync(path.join(staged, 'src', 'main.js'), 'utf8'), 'main-v1');
    assert.strictEqual(fs.readFileSync(path.join(staged, 'tools', 'review.py'), 'utf8'), 'review-v1');
    assert.strictEqual(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'), '{"version":"1.2.3"}');
    assert.strictEqual(fs.existsSync(path.join(staged, 'node_modules')), false);
    assert.deepStrictEqual(RUNTIME_ENTRIES, ['src', 'tools']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new process snapshot reads fresh source without replacing another snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  const runner = path.join(root, 'runner');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v1');
    fs.writeFileSync(path.join(source, 'tools', 'review.py'), 'review');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');

    const first = stageSource(source, runner, 100);
    fs.writeFileSync(path.join(source, 'src', 'main.js'), 'main-v2');
    const second = stageSource(source, runner, 200);

    assert.strictEqual(fs.readFileSync(path.join(first, 'src', 'main.js'), 'utf8'), 'main-v1');
    assert.strictEqual(fs.readFileSync(path.join(second, 'src', 'main.js'), 'utf8'), 'main-v2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails clearly when a runtime source directory is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-win-dev-'));
  const source = path.join(root, 'source');
  try {
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    assert.throws(
      () => stageSource(source, path.join(root, 'runner'), 42),
      /development source is missing tools\//,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
