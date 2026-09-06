// Tests for src/log-cap.js — a single log file cannot outgrow its cap.
//
// These run against a real temp directory rather than a fake fs: what the trim
// depends on is real file semantics (reading from an offset, truncation, and an
// O_APPEND descriptor that keeps writing through both), and a fake would only
// restate the behaviour being trusted.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateIfLarge, trimToTail, OLD_SUFFIX } = require('../src/log-cap');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-log-cap-'));
  try {
    fn(dir);
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

// Lines are numbered so a test can prove which end of the file survived.
function lines(from, to) {
  let out = '';
  for (let i = from; i <= to; i++) out += `line ${i}\n`;
  return out;
}

console.log('log-cap');

test('a file under the cap is left alone', (dir) => {
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, lines(1, 10));
  assert.strictEqual(trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512 }), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), lines(1, 10));
});

test('a missing file is not an error', (dir) => {
  assert.strictEqual(trimToTail({ fs, file: path.join(dir, 'gone.log'), maxBytes: 1 }), null);
});

test('an oversized file keeps its most recent lines and drops the rest', (dir) => {
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, lines(1, 2000));
  const before = fs.statSync(file).size;
  const result = trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512, now: () => 0 });
  assert.ok(result, 'expected a trim');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith('[agent-term '), 'the marker says what happened');
  assert.ok(after.includes('bytes of older output were dropped'));
  assert.ok(after.endsWith('line 2000\n'), 'the newest line survives');
  assert.ok(!after.includes('line 1\n'), 'the oldest is gone');
  assert.ok(fs.statSync(file).size < before / 4, 'the file actually shrank');
  assert.strictEqual(result.dropped + result.kept, before);
});

test('the kept tail starts on a line boundary', (dir) => {
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, lines(1, 2000));
  trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512, now: () => 0 });
  const body = fs.readFileSync(file, 'utf8').split('\n').slice(1); // past the marker
  assert.ok(/^line \d+$/.test(body[0]), `first kept line is whole: ${JSON.stringify(body[0])}`);
});

test('a single enormous line is dropped rather than half-kept', (dir) => {
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, 'x'.repeat(20000)); // no newline anywhere
  const result = trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512, now: () => 0 });
  assert.strictEqual(result.kept, 0);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('x'), 'no fragment of it remains');
});

test("a live O_APPEND writer keeps writing into the trimmed file", (dir) => {
  // The case this exists for: the descriptor belongs to this process's stdout,
  // opened by the parent before exec, and the trim happens underneath it.
  const file = path.join(dir, 'console.log');
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, lines(1, 2000));
    trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512, now: () => 0 });
    fs.writeSync(fd, 'after the trim\n');
  } finally {
    fs.closeSync(fd);
  }
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  assert.ok(text.endsWith('line 2000\nafter the trim\n'), 'the new write follows the kept tail');
  assert.strictEqual(buf.indexOf(0x00), -1, 'no zero-filled hole from a stale offset');
});

test('trimming twice bounds a file that keeps growing', (dir) => {
  const file = path.join(dir, 'console.log');
  const fd = fs.openSync(file, 'a');
  const sizes = [];
  try {
    for (let round = 0; round < 3; round++) {
      fs.writeSync(fd, lines(1, 2000));
      trimToTail({ fs, file, maxBytes: 4096, tailBytes: 512, now: () => 0 });
      sizes.push(fs.statSync(file).size);
    }
  } finally {
    fs.closeSync(fd);
  }
  for (const size of sizes) assert.ok(size < 4096, `stayed under the cap: ${size}`);
});

test('rotateIfLarge moves the file aside only past the cap', (dir) => {
  const file = path.join(dir, 'main-1.log');
  fs.writeFileSync(file, 'small');
  assert.strictEqual(rotateIfLarge({ fs, file, bytes: 5, maxBytes: 4096 }), false);
  assert.ok(!fs.existsSync(file + OLD_SUFFIX), 'nothing rotated');

  fs.writeFileSync(file, lines(1, 2000));
  assert.strictEqual(rotateIfLarge({ fs, file, bytes: fs.statSync(file).size, maxBytes: 4096 }), true);
  assert.ok(!fs.existsSync(file), 'the live name is free for a fresh handle');
  assert.ok(fs.readFileSync(file + OLD_SUFFIX, 'utf8').endsWith('line 2000\n'));
});

test('rotating again replaces the previous generation, so two files is the ceiling', (dir) => {
  const file = path.join(dir, 'main-1.log');
  fs.writeFileSync(file, 'first\n');
  rotateIfLarge({ fs, file, bytes: 999, maxBytes: 1 });
  fs.writeFileSync(file, 'second\n');
  rotateIfLarge({ fs, file, bytes: 999, maxBytes: 1 });
  assert.strictEqual(fs.readFileSync(file + OLD_SUFFIX, 'utf8'), 'second\n');
  assert.deepStrictEqual(fs.readdirSync(dir), ['main-1.log' + OLD_SUFFIX]);
});

test('a rotated log is reopened at the live name and keeps its history', (dir) => {
  // The caller's sequence: close, rotate, reopen. Both generations readable.
  const file = path.join(dir, 'main-1.log');
  let fd = fs.openSync(file, 'a');
  fs.writeSync(fd, 'old generation\n');
  fs.closeSync(fd);
  rotateIfLarge({ fs, file, bytes: fs.statSync(file).size, maxBytes: 1 });
  fd = fs.openSync(file, 'a');
  fs.writeSync(fd, 'new generation\n');
  fs.closeSync(fd);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new generation\n');
  assert.strictEqual(fs.readFileSync(file + OLD_SUFFIX, 'utf8'), 'old generation\n');
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
