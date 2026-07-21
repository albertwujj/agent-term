const {
  shouldInsertCaretPositionShortcut,
  shouldShowCaretDiagnosticsShortcut,
} = require('../src/caret-shortcut');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n    Expected: ${expected}\n    Actual:   ${actual}`);
  }
}

function createInput(overrides = {}) {
  return {
    type: 'keyDown',
    key: 'k',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...overrides,
  };
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}`);
      console.log(`  ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

test('Ctrl+K triggers caret insertion on Windows', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ control: true }), 'win32'),
    true,
    'Windows Ctrl+K should be intercepted'
  );
});

test('Cmd+K triggers caret insertion on macOS', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ meta: true }), 'darwin'),
    true,
    'macOS Cmd+K should be intercepted'
  );
});

test('keyUp does not trigger caret insertion', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ control: true, type: 'keyUp' }), 'win32'),
    false,
    'Only keyDown should trigger the shortcut'
  );
});

test('Ctrl+Shift+K does not trigger caret insertion', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ control: true, shift: true }), 'win32'),
    false,
    'Shift-modified Ctrl+K should not be intercepted'
  );
});

test('Ctrl+Meta+K does not trigger caret insertion', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ control: true, meta: true }), 'win32'),
    false,
    'Mixed modifier Ctrl+K should not be intercepted'
  );
});

test('Ctrl+Alt+K triggers caret diagnostics on Windows', () => {
  assertEqual(
    shouldShowCaretDiagnosticsShortcut(createInput({ control: true, alt: true }), 'win32'),
    true,
    'Windows Ctrl+Alt+K should be intercepted for diagnostics'
  );
});

test('Cmd+Alt+K triggers caret diagnostics on macOS', () => {
  assertEqual(
    shouldShowCaretDiagnosticsShortcut(createInput({ meta: true, alt: true }), 'darwin'),
    true,
    'macOS Cmd+Alt+K should be intercepted for diagnostics'
  );
});

test('Ctrl+Alt+Shift+K does not trigger caret diagnostics', () => {
  assertEqual(
    shouldShowCaretDiagnosticsShortcut(createInput({ control: true, alt: true, shift: true }), 'win32'),
    false,
    'Shift-modified diagnostics shortcut should not be intercepted'
  );
});

test('plain Ctrl+K does not trigger caret diagnostics', () => {
  assertEqual(
    shouldShowCaretDiagnosticsShortcut(createInput({ control: true }), 'win32'),
    false,
    'Diagnostics shortcut requires Alt'
  );
});

test('non-K keys do not trigger caret insertion', () => {
  assertEqual(
    shouldInsertCaretPositionShortcut(createInput({ control: true, key: '.' }), 'win32'),
    false,
    'Only the K shortcut should be intercepted'
  );
});

test('non-K keys do not trigger caret diagnostics', () => {
  assertEqual(
    shouldShowCaretDiagnosticsShortcut(createInput({ control: true, alt: true, key: '.' }), 'win32'),
    false,
    'Only the K diagnostics shortcut should be intercepted'
  );
});

runTests();
