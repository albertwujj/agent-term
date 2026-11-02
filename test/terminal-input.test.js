// node test/terminal-input.test.js — the user's input vs the terminal's own
// traffic on the channel to the pty (src/terminal-input.js).
const assert = require('assert');
const { isTerminalProtocol } = require('../src/terminal-input');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

test('typed text and control keys are input', () => {
  for (const data of ['a', 'hello', '\r', '\n', '\t', '\x7f', '\x03', '\x15']) {
    assert.equal(isTerminalProtocol(data), false, JSON.stringify(data));
  }
});

test('a bare Esc is the Esc key', () => {
  assert.equal(isTerminalProtocol('\x1b'), false);
});

test('Alt+key is input: ESC with no protocol introducer after it', () => {
  assert.equal(isTerminalProtocol('\x1bf'), false);
});

test('a bracketed paste is input', () => {
  assert.equal(isTerminalProtocol('\x1b[200~use the second uploader\x1b[201~'), false);
  assert.equal(isTerminalProtocol('\x1b[200~a\nb\n\x1b[201~'), false, 'multi-line');
  assert.equal(isTerminalProtocol('\x1b[200~\x1b[201~'), false, 'empty');
});

test('focus reports, probe replies and mouse reports are protocol', () => {
  for (const data of [
    '\x1b[I', '\x1b[O',              // focus in / out
    '\x1b[12;40R',                   // cursor position
    '\x1b[?1;2c',                    // device attributes
    '\x1b]4;1;rgb:ff/00/00\x1b\\',   // palette query
    '\x1b[<0;10;5M',                 // mouse report
    '\x1bP1$r0m\x1b\\',              // DCS reply
  ]) {
    assert.equal(isTerminalProtocol(data), true, JSON.stringify(data));
  }
});

test('arrow, function and navigation keys read as protocol', () => {
  for (const data of ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOP', '\x1b[5~', '\x1b[Z']) {
    assert.equal(isTerminalProtocol(data), true, JSON.stringify(data));
  }
});

test('a paste\'s closing bracket alone is not a paste', () => {
  assert.equal(isTerminalProtocol('\x1b[201~'), true);
});

test('anything but a string is not protocol', () => {
  for (const data of [undefined, null, 42, Buffer.from('\x1b[I')]) {
    assert.equal(isTerminalProtocol(data), false, String(data));
  }
});

console.log(`\nterminal-input: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
