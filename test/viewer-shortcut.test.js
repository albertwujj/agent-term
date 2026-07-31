const { getViewerShortcutAction } = require('../src/viewer-shortcut');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message}\n    Expected: ${expected}\n    Actual:   ${actual}`);
  }
}

function createElectronInput(overrides = {}) {
  return {
    type: 'keyDown',
    key: 'u',
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

function createDomInput(overrides = {}) {
  return {
    type: 'keydown',
    key: 'u',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

test('Ctrl+Shift+U opens the selector on Windows', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ control: true, shift: true }), 'win32'),
    'selector'
  );
});

test('Cmd+Shift+U opens the selector with DOM modifier fields on macOS', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ key: 'U', metaKey: true, shiftKey: true }),
      'darwin'
    ),
    'selector'
  );
});

test('Ctrl+Shift+O toggles the band on Linux', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ key: 'O', ctrlKey: true, shiftKey: true }),
      'linux'
    ),
    'toggle'
  );
});

test('Cmd+Shift+O toggles the band on macOS', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ key: 'o', meta: true, shift: true }), 'darwin'),
    'toggle'
  );
});

test('Alt conflicts with the selector shortcut', () => {
  assertEqual(
    getViewerShortcutAction(
      createElectronInput({ control: true, shift: true, alt: true }),
      'win32'
    ),
    null
  );
});

test('Alt conflicts with the toggle shortcut through DOM fields', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ key: 'o', ctrlKey: true, shiftKey: true, altKey: true }),
      'linux'
    ),
    null
  );
});

test('Shift is required', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ control: true }), 'win32'),
    null
  );
});

test('the platform primary modifier is required', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ shift: true }), 'win32'),
    null
  );
});

test('Ctrl remains a supported alias on macOS', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ control: true, shift: true }), 'darwin'),
    'selector'
  );
});

test('Cmd remains a supported alias on Windows', () => {
  assertEqual(
    getViewerShortcutAction(createElectronInput({ key: 'o', meta: true, shift: true }), 'win32'),
    'toggle'
  );
});

test('mixed Ctrl and Cmd modifiers conflict', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ ctrlKey: true, metaKey: true, shiftKey: true }),
      'darwin'
    ),
    null
  );
});

test('Ctrl+Shift+I toggles full size on Windows', () => {
  assertEqual(
    getViewerShortcutAction(
      createElectronInput({ key: 'i', control: true, shift: true }),
      'win32'
    ),
    'size'
  );
});

test('Cmd+Shift+I toggles full size with DOM modifier fields on macOS', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ key: 'I', metaKey: true, shiftKey: true }),
      'darwin'
    ),
    'size'
  );
});

test('Alt conflicts with the size shortcut', () => {
  assertEqual(
    getViewerShortcutAction(
      createDomInput({ key: 'i', ctrlKey: true, shiftKey: true, altKey: true }),
      'linux'
    ),
    null
  );
});

test('unrelated keys do not produce an action', () => {
  assertEqual(
    getViewerShortcutAction(
      createElectronInput({ key: 'p', control: true, shift: true }),
      'linux'
    ),
    null
  );
});

test('Electron keyUp input does not produce an action', () => {
  assertEqual(
    getViewerShortcutAction(
      createElectronInput({ type: 'keyUp', control: true, shift: true }),
      'win32'
    ),
    null
  );
});

test('an input without a type can still produce an action', () => {
  const input = createDomInput({ ctrlKey: true, shiftKey: true });
  delete input.type;
  assertEqual(getViewerShortcutAction(input, 'linux'), 'selector');
});

runTests();
