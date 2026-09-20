const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOscTitleWatcher } = require('../src/osc-title-watch');

test('OSC titles survive every PTY split, BEL/ST terminators, and unicode', () => {
  const wire = 'output\x1b]0;Thinking | codex | topic ⠋\x07body'
    + '\x1b]2;Ready | codex | topic\x1b\\\x1b]0;\x07';
  for (let split = 0; split <= wire.length; split++) {
    const titles = [];
    const write = createOscTitleWatcher(t => titles.push(t));
    write(wire.slice(0, split)); write(wire.slice(split));
    assert.deepEqual(titles, ['Thinking | codex | topic ⠋', 'Ready | codex | topic', '']);
  }
  const titles = [];
  const write = createOscTitleWatcher(t => titles.push(t));
  for (const ch of '\x9d2;◐ topic\x9c\x1b[23;0t') write(ch);
  assert.deepEqual(titles, ['◐ topic', null]);
});

test('unrelated OSC and embedded control-string payloads cannot set activity', () => {
  const titles = [];
  const write = createOscTitleWatcher(t => titles.push(t));
  for (const prefix of ['\x1bP', '\x1b_', '\x1b^', '\x1bX', '\x90', '\x9f']) {
    write(prefix + '\x1b]0;Ready | codex\x07payload\x1b\\');
  }
  write('\x1b]52;c;Ready | codex\x07\x1b]9;notification\x07');
  write('\x1b]0;cancelled\x18\x1b]0;cancelled\x1a');
  write('\x1b]0;broken\x1b[0m');
  write('\x1b]2;good\x07');
  assert.deepEqual(titles, ['good']);
});

test('oversized title withdraws evidence and parser recovers at the next title', () => {
  const titles = [];
  const write = createOscTitleWatcher(t => titles.push(t));
  write('\x1b]0;' + 'x'.repeat(100_000) + '\x07\x1b]0;ready\x07');
  write('\x1b[23;2t');
  assert.deepEqual(titles, [null, 'ready', null]);
});
