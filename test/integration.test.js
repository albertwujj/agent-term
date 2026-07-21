// Integration tests with xterm.js
// Run with: node test/integration.test.js
//
// These tests verify our code works correctly with actual xterm.js APIs,
// catching issues like the allowProposedApi error that unit tests miss.

const { JSDOM } = require('jsdom');

// Set up DOM environment before requiring xterm
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminal"></div></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;

// Mock browser APIs that xterm.js needs but jsdom doesn't provide
global.window.matchMedia = () => ({
  matches: false,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
});

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock requestAnimationFrame
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Now require xterm (it needs DOM globals)
const { Terminal } = require('@xterm/xterm');
const {
  attachTerminalMouseShortcuts,
  isTerminalDecorationTarget,
} = require('../src/terminal-mouse');
const {
  handleDecorationPointerAction,
} = require('../src/terminal-decoration-actions');
const {
  extractDroppedPaths,
  hasSupportedPathDropType,
} = require('../src/drag-drop-paths');
const {
  copySelectionToClipboard,
  handleTerminalKeydown,
} = require('../src/terminal-keyboard');

// =============================================================================
// Test Framework
// =============================================================================

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
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
      if (e.stack) {
        console.log(`  ${e.stack.split('\n')[1]}`);
      }
      failed++;
    }
  }
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) {
    throw new Error(msg || 'Expected true but got false');
  }
}

function createKeyEvent(overrides = {}) {
  let defaultPrevented = false;
  return {
    type: 'keydown',
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => {
      defaultPrevented = true;
    },
    isDefaultPrevented: () => defaultPrevented,
    ...overrides,
  };
}

function createMouseHandlerEvent(overrides = {}) {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    type: 'contextmenu',
    ctrlKey: false,
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
    isDefaultPrevented: () => defaultPrevented,
    isPropagationStopped: () => propagationStopped,
    ...overrides,
  };
}

// =============================================================================
// Helper: Create terminal with our settings
// =============================================================================

function createTestTerminal(options = {}) {
  const container = document.getElementById('terminal');
  container.innerHTML = '';
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true, // Required for decorations
    ...options,
  });
  terminal.open(container);
  return terminal;
}

// Helper to write and wait for processing
function writeAndWait(terminal, text) {
  return new Promise((resolve) => {
    terminal.write(text, resolve);
  });
}

// =============================================================================
// Tests: Terminal keyboard shortcuts
// =============================================================================

console.log('\n--- terminal keyboard shortcuts ---\n');

test('Ctrl+F opens search on non-mac platforms', () => {
  let openCalls = 0;
  const event = createKeyEvent({ key: 'F', ctrlKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {},
    platform: 'linux',
    searchState: { isOpen: false },
    openSearchBar: () => { openCalls++; },
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Search shortcut should be intercepted');
  assertEqual(openCalls, 1, 'Search should open once');
  assertTrue(event.isDefaultPrevented(), 'Search shortcut should prevent the browser default');
});

test('Cmd+F opens search on macOS', () => {
  let openCalls = 0;
  const event = createKeyEvent({ key: 'F', metaKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {},
    platform: 'darwin',
    searchState: { isOpen: false },
    openSearchBar: () => { openCalls++; },
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Mac search shortcut should be intercepted');
  assertEqual(openCalls, 1, 'Mac search should open once');
  assertTrue(event.isDefaultPrevented(), 'Mac search shortcut should prevent the browser default');
});

test('Ctrl+F opens search in the alternate buffer', () => {
  let openCalls = 0;
  const event = createKeyEvent({ key: 'F', ctrlKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: { buffer: { active: { type: 'alternate' } } },
    platform: 'linux',
    searchState: { isOpen: false },
    openSearchBar: () => { openCalls++; },
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Search shortcut should still be intercepted in the alternate buffer');
  assertEqual(openCalls, 1, 'Search should still open in the alternate buffer');
  assertTrue(event.isDefaultPrevented(), 'Alternate-buffer search shortcut should prevent the browser default');
});

test('Escape closes search when open', () => {
  let closeCalls = 0;
  const event = createKeyEvent({ key: 'Escape' });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {},
    platform: 'darwin',
    getSearchState: () => ({ isOpen: true }),
    openSearchBar: () => {},
    closeSearchBar: () => { closeCalls++; },
    pasteFromClipboard: () => {},
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Escape should be intercepted while search is open');
  assertEqual(closeCalls, 1, 'Escape should close search once');
});

test('copySelectionToClipboard preserves viewport after clearing selection', () => {
  let copiedText = null;
  let scrollLine = null;
  let clearCalls = 0;

  copySelectionToClipboard({
    terminal: {
      getSelection: () => 'selected text',
      buffer: { active: { viewportY: 42 } },
      clearSelection: () => { clearCalls++; },
      scrollToLine: (line) => { scrollLine = line; },
    },
    writeClipboardText: (text) => { copiedText = text; },
  });

  assertEqual(copiedText, 'selected text', 'Selection should be copied');
  assertEqual(clearCalls, 1, 'Selection should be cleared once');
  assertEqual(scrollLine, 42, 'Viewport should be restored after copy');
});

test('Cmd+C copies selection on macOS', () => {
  let copiedText = null;
  let clearCalls = 0;
  let scrollLine = null;
  const event = createKeyEvent({ key: 'c', metaKey: true });
  const terminal = {
    hasSelection: () => true,
    getSelection: () => 'mac selection',
    buffer: { active: { viewportY: 7 } },
    clearSelection: () => { clearCalls++; },
    scrollToLine: (line) => { scrollLine = line; },
  };

  const allowed = handleTerminalKeydown({
    event,
    terminal,
    platform: 'darwin',
    searchState: { isOpen: false },
    openSearchBar: () => {},
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: (text) => { copiedText = text; },
  });

  assertEqual(allowed, false, 'Cmd+C should be intercepted when selection exists');
  assertEqual(copiedText, 'mac selection', 'Cmd+C should copy the selection');
  assertEqual(clearCalls, 1, 'Cmd+C should clear the selection');
  assertEqual(scrollLine, 7, 'Cmd+C should restore the viewport');
});

test('Ctrl+C copies selection on Windows', () => {
  let copiedText = null;
  let clearCalls = 0;
  let scrollLine = null;
  const event = createKeyEvent({ key: 'c', ctrlKey: true });
  const terminal = {
    hasSelection: () => true,
    getSelection: () => 'windows selection',
    buffer: { active: { viewportY: 9 } },
    clearSelection: () => { clearCalls++; },
    scrollToLine: (line) => { scrollLine = line; },
  };

  const allowed = handleTerminalKeydown({
    event,
    terminal,
    platform: 'win32',
    searchState: { isOpen: false },
    openSearchBar: () => {},
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: (text) => { copiedText = text; },
  });

  assertEqual(allowed, false, 'Ctrl+C should be intercepted when selection exists on Windows');
  assertEqual(copiedText, 'windows selection', 'Ctrl+C should copy the selection on Windows');
  assertEqual(clearCalls, 1, 'Ctrl+C should clear the selection on Windows');
  assertEqual(scrollLine, 9, 'Ctrl+C should restore the viewport on Windows');
});

test('Ctrl+C is left alone on macOS', () => {
  let copiedText = null;
  const event = createKeyEvent({ key: 'c', ctrlKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {
      hasSelection: () => true,
      getSelection: () => 'mac selection',
      buffer: { active: { viewportY: 7 } },
      clearSelection: () => {},
      scrollToLine: () => {},
    },
    platform: 'darwin',
    searchState: { isOpen: false },
    openSearchBar: () => {},
    closeSearchBar: () => {},
    pasteFromClipboard: () => {},
    writeClipboardText: (text) => { copiedText = text; },
  });

  assertEqual(allowed, true, 'Ctrl+C should keep shell behavior on macOS');
  assertEqual(copiedText, null, 'Ctrl+C should not trigger clipboard copy on macOS');
});

test('Cmd+V pastes on macOS', () => {
  let pasteCalls = 0;
  const event = createKeyEvent({ key: 'v', metaKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {
      hasSelection: () => false,
    },
    platform: 'darwin',
    searchState: { isOpen: false },
    openSearchBar: () => {},
    closeSearchBar: () => {},
    pasteFromClipboard: () => { pasteCalls++; },
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Cmd+V should be intercepted on macOS');
  assertEqual(pasteCalls, 1, 'Cmd+V should trigger paste');
  assertTrue(event.isDefaultPrevented(), 'Cmd+V should prevent the browser default');
});

test('Ctrl+V pastes on Windows', () => {
  let pasteCalls = 0;
  const event = createKeyEvent({ key: 'v', ctrlKey: true });

  const allowed = handleTerminalKeydown({
    event,
    terminal: {
      hasSelection: () => false,
    },
    platform: 'win32',
    searchState: { isOpen: false },
    openSearchBar: () => {},
    closeSearchBar: () => {},
    pasteFromClipboard: () => { pasteCalls++; },
    writeClipboardText: () => {},
  });

  assertEqual(allowed, false, 'Ctrl+V should be intercepted on Windows');
  assertEqual(pasteCalls, 1, 'Ctrl+V should trigger paste on Windows');
  assertTrue(event.isDefaultPrevented(), 'Ctrl+V should prevent the browser default on Windows');
});

// =============================================================================
// Tests: Terminal mouse shortcuts
// =============================================================================

console.log('\n--- terminal mouse shortcuts ---\n');

test('detects decoration targets within terminal overlays', () => {
  const screen = document.createElement('div');
  const decoration = document.createElement('div');
  const child = document.createElement('span');

  decoration.className = 'xterm-decoration-container';
  decoration.appendChild(child);
  screen.appendChild(decoration);

  assertTrue(isTerminalDecorationTarget(child), 'Nested decoration child should be detected');
  assertTrue(!isTerminalDecorationTarget(screen), 'Plain terminal screen should not be detected as a decoration');
});

test('middle-click scrolls terminal to bottom and refocuses', () => {
  const screen = document.createElement('div');
  let scrollCalls = 0;
  let focusCalls = 0;

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => { scrollCalls++; },
      focus: () => { focusCalls++; },
    },
  });

  const event = new window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 1,
  });

  const defaultAllowed = screen.dispatchEvent(event);

  assertEqual(defaultAllowed, false, 'Middle-click should prevent the browser default');
  assertEqual(scrollCalls, 1, 'Middle-click should scroll once');
  assertEqual(focusCalls, 1, 'Middle-click should refocus the terminal');
});

test('middle-click ignores decorated terminal targets', () => {
  const screen = document.createElement('div');
  const decoration = document.createElement('div');
  const child = document.createElement('span');
  let scrollCalls = 0;

  decoration.className = 'xterm-decoration-container';
  decoration.appendChild(child);
  screen.appendChild(decoration);

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => { scrollCalls++; },
      focus: () => {},
    },
  });

  const event = new window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 1,
  });

  const defaultAllowed = child.dispatchEvent(event);

  assertEqual(defaultAllowed, true, 'Decorated middle-click should fall through');
  assertEqual(scrollCalls, 0, 'Decorated middle-click should not scroll');
});

test('middle-click ignores callbacks that report clickable matches', () => {
  const screen = document.createElement('div');
  let scrollCalls = 0;

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => { scrollCalls++; },
      focus: () => {},
    },
    isClickableMatchEvent: () => true,
  });

  const event = new window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 1,
  });

  const defaultAllowed = screen.dispatchEvent(event);

  assertEqual(defaultAllowed, true, 'Clickable middle-click should fall through');
  assertEqual(scrollCalls, 0, 'Clickable middle-click should not scroll');
});

test('right-click leaves terminal targets alone', () => {
  const screen = document.createElement('div');

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => {},
      focus: () => {},
    },
  });

  const event = new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
  });

  const defaultAllowed = screen.dispatchEvent(event);

  assertEqual(defaultAllowed, true, 'Right-click should fall through');
});

test('right-click leaves decorated terminal targets alone', () => {
  const screen = document.createElement('div');
  const decoration = document.createElement('div');
  const child = document.createElement('span');

  decoration.className = 'xterm-decoration-container';
  decoration.appendChild(child);
  screen.appendChild(decoration);

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => {},
      focus: () => {},
    },
  });

  const event = new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
  });

  const defaultAllowed = child.dispatchEvent(event);

  assertEqual(defaultAllowed, true, 'Decorated right-click should fall through');
});

test('right-button mousedown is left alone', () => {
  const screen = document.createElement('div');

  attachTerminalMouseShortcuts({
    screenElement: screen,
    terminal: {
      scrollToBottom: () => {},
      focus: () => {},
    },
  });

  const event = new window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 2,
  });

  const defaultAllowed = screen.dispatchEvent(event);

  assertEqual(defaultAllowed, true, 'Right-button mousedown should fall through');
});

test('decoration click activates navigation normally', async () => {
  const calls = [];
  const result = await handleDecorationPointerAction({
    event: createMouseHandlerEvent({ type: 'click' }),
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'activate', 'Plain click should activate the decoration');
  assertEqual(calls.length, 1, 'Plain click should call the action once');
  assertEqual(calls[0][1].copyResponse, undefined, 'Plain click should not request debug payloads');
});

test('decoration Ctrl+Alt+click copies the debug payload', async () => {
  const calls = [];
  const result = await handleDecorationPointerAction({
    event: createMouseHandlerEvent({ type: 'click', ctrlKey: true, altKey: true }),
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'debug', 'Ctrl+Alt+click should switch to debug payload copy');
  assertEqual(calls.length, 1, 'Ctrl+Alt+click should still invoke the action once');
  assertEqual(calls[0][1].copyResponse, true, 'Ctrl+Alt+click should request the debug payload');
});

test('decoration Cmd+Alt+click copies the debug payload (Mac chord)', async () => {
  const calls = [];
  const result = await handleDecorationPointerAction({
    event: createMouseHandlerEvent({ type: 'click', metaKey: true, altKey: true }),
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'debug', 'Cmd+Alt+click should switch to debug payload copy');
  assertEqual(calls[0][1].copyResponse, true, 'Cmd+Alt+click should request the debug payload');
});

test('decoration Ctrl+click alone activates with the modifier forwarded', async () => {
  const calls = [];
  const result = await handleDecorationPointerAction({
    event: createMouseHandlerEvent({ type: 'click', ctrlKey: true }),
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'activate', 'Plain Ctrl+click is a normal activation now');
  assertEqual(calls[0][1].copyResponse, undefined, 'Plain Ctrl+click should not request debug payloads');
  assertEqual(calls[0][1].modifiers.ctrlKey, true, 'ctrlKey should be forwarded for action-level branching');
});

test('decoration Alt+click activates with altKey forwarded (chooser modifier)', async () => {
  const calls = [];
  const result = await handleDecorationPointerAction({
    event: createMouseHandlerEvent({ type: 'click', altKey: true }),
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'activate', 'Alt+click is a normal activation');
  assertEqual(calls[0][1].copyResponse, undefined, 'Alt+click should not request debug payloads');
  assertEqual(calls[0][1].modifiers.altKey, true, 'altKey should be forwarded for the search-everywhere chooser');
});

test('decoration right-click is ignored', async () => {
  const calls = [];
  const event = createMouseHandlerEvent({ type: 'contextmenu' });
  const result = await handleDecorationPointerAction({
    event,
    match: {
      action: async (...args) => { calls.push(args); },
    },
  });

  assertEqual(result, 'ignored', 'Right-click should be ignored by decoration actions');
  assertEqual(calls.length, 0, 'Right-click should not activate the decoration');
  assertEqual(event.isDefaultPrevented(), false, 'Ignored right-click should not prevent default');
});

// =============================================================================
// Tests: Terminal scroll behavior
// =============================================================================

console.log('\n--- terminal scroll behavior ---\n');

test('xterm keeps the live viewport at the bottom while output streams', async () => {
  const terminal = createTestTerminal({ rows: 5 });

  for (let i = 0; i < 12; i++) {
    await writeAndWait(terminal, `line ${i}\r\n`);
  }

  terminal.scrollToBottom();
  const buffer = terminal.buffer.active;
  assertEqual(buffer.viewportY, buffer.baseY, 'Setup should start at the live bottom');

  await writeAndWait(terminal, 'line 12\r\n');
  await writeAndWait(terminal, 'line 13\r\n');

  assertEqual(buffer.viewportY, buffer.baseY, 'Native xterm output should keep the live viewport at bottom');
  terminal.dispose();
});

test('xterm preserves manual scrollback while new output arrives', async () => {
  const terminal = createTestTerminal({ rows: 5 });

  for (let i = 0; i < 20; i++) {
    await writeAndWait(terminal, `line ${i}\r\n`);
  }

  terminal.scrollToLine(3);
  const buffer = terminal.buffer.active;
  const pinnedViewportY = buffer.viewportY;
  assertTrue(pinnedViewportY < buffer.baseY, 'Setup should put the viewport into scrollback');

  await writeAndWait(terminal, 'line 20\r\n');
  await writeAndWait(terminal, 'line 21\r\n');

  assertEqual(buffer.viewportY, pinnedViewportY, 'Native xterm output should not steal the viewport from scrollback');
  terminal.dispose();
});

// =============================================================================
// Tests: Alternate screen
// =============================================================================

console.log('\n--- alternate screen ---\n');

test('xterm emits buffer change events for alternate-screen enter/exit', async () => {
  const terminal = createTestTerminal({ rows: 5 });
  const seen = [];

  terminal.buffer.onBufferChange((buffer) => {
    seen.push(buffer.type);
  });

  await writeAndWait(terminal, '\x1b[?1049h');
  await writeAndWait(terminal, '\x1b[?1049l');

  assertEqual(seen, ['alternate', 'normal'], 'DECSET 1049 should switch between alternate and normal buffers');
  terminal.dispose();
});

test('xterm restores normal scrollback after leaving the alternate screen', async () => {
  const terminal = createTestTerminal({ rows: 5, cols: 40 });

  await writeAndWait(terminal, 'normal 1\r\nnormal 2\r\n');
  assertEqual(terminal.buffer.active.type, 'normal', 'Setup should start in the normal buffer');

  await writeAndWait(terminal, '\x1b[?1049h\x1b[2J\x1b[Halt screen');
  assertEqual(terminal.buffer.active.type, 'alternate', 'DECSET 1049 should activate the alternate buffer');
  assertEqual(
    terminal.buffer.active.getLine(0).translateToString().trim(),
    'alt screen',
    'Alternate-screen output should render in the alternate buffer',
  );

  await writeAndWait(terminal, '\x1b[?1049l');

  assertEqual(terminal.buffer.active.type, 'normal', 'DECRST 1049 should restore the normal buffer');
  assertEqual(
    terminal.buffer.active.getLine(0).translateToString().trim(),
    'normal 1',
    'Normal-buffer content should come back after leaving the alternate screen',
  );
  assertEqual(
    terminal.buffer.active.getLine(1).translateToString().trim(),
    'normal 2',
    'Normal scrollback should remain intact after alternate-screen use',
  );

  terminal.dispose();
});

test('can create clickable decorations in the alternate buffer', async () => {
  const terminal = createTestTerminal({ rows: 5, cols: 60 });

  await writeAndWait(terminal, '\x1b[?1049h\x1b[2J\x1b[Hopen src/foo.ts:42');
  const line = terminal.buffer.active.getLine(0);
  const text = line.translateToString();
  const matches = parseRow(text);
  const fileMatch = matches.find((match) => match.patternName === 'file_line');

  assertTrue(terminal.buffer.active.type === 'alternate', 'Setup should be in the alternate buffer');
  assertTrue(fileMatch !== undefined, 'Alternate-buffer line should still be parsed for file references');

  const marker = terminal.registerMarker(-terminal.buffer.active.cursorY);
  const decoration = terminal.registerDecoration({
    marker,
    x: fileMatch.start,
    width: fileMatch.text.length,
  });

  assertTrue(decoration !== undefined, 'Alternate-buffer match should still be decoratable');

  decoration.dispose();
  marker.dispose();
  terminal.dispose();
});

test('alt-buffer decoration onRender can force the element visible', async () => {
  const terminal = createTestTerminal({ rows: 5, cols: 60 });

  await writeAndWait(terminal, '\x1b[?1049h\x1b[2J\x1b[Hopen src/foo.ts:42');
  const marker = terminal.registerMarker(-terminal.buffer.active.cursorY);
  const decoration = terminal.registerDecoration({
    marker,
    x: 5,
    width: 13,
    layer: 'top',
  });

  decoration.onRender((element) => {
    element.style.display = 'block';
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const rendered = document.querySelector('.xterm-decoration');
  assertTrue(rendered !== null, 'Decoration should render an element in the DOM');
  assertEqual(rendered.style.display, 'block', 'onRender should be able to restore alt-buffer decoration visibility');

  decoration.dispose();
  marker.dispose();
  terminal.dispose();
});

test('regular-buffer decorations still hide when scrolled out of view', async () => {
  const terminal = createTestTerminal({ rows: 3, cols: 60 });

  await writeAndWait(terminal, 'open src/foo.ts:42\r\n');
  const marker = terminal.registerMarker(-(terminal.buffer.active.cursorY + terminal.buffer.active.baseY));
  const decoration = terminal.registerDecoration({
    marker,
    x: 5,
    width: 13,
    layer: 'top',
  });

  decoration.onRender((element) => {
    const viewportLine = marker.line - terminal.buffer.active.viewportY;
    if (terminal.buffer.active.type === 'alternate' && viewportLine >= 0 && viewportLine < terminal.rows) {
      element.style.display = 'block';
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const rendered = document.querySelector('.xterm-decoration');
  assertTrue(rendered !== null, 'Decoration should render while the row is visible');

  await writeAndWait(terminal, 'line 2\r\nline 3\r\nline 4\r\nline 5\r\n');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEqual(rendered.style.display, 'none', 'Regular-buffer decoration should hide after scrolling out of view');

  decoration.dispose();
  marker.dispose();
  terminal.dispose();
});

// =============================================================================
// Tests: Drag and drop paths
// =============================================================================

console.log('\n--- drag and drop paths ---\n');

test('extractDroppedPaths uses dropped File objects when available', () => {
  const firstFile = { name: 'alpha.txt' };
  const secondFile = { name: 'beta.txt' };
  const droppedPaths = extractDroppedPaths({
    dataTransfer: {
      files: [firstFile, secondFile],
      getData: () => '',
    },
    getPathForFile: (file) => {
      if (file === firstFile) return 'C:\\tmp\\alpha.txt';
      if (file === secondFile) return 'C:\\tmp\\beta.txt';
      return '';
    },
    platform: 'win32',
  });

  assertEqual(droppedPaths, ['C:\\tmp\\alpha.txt', 'C:\\tmp\\beta.txt']);
});

test('extractDroppedPaths falls back to text/uri-list for Windows file URIs', () => {
  const droppedPaths = extractDroppedPaths({
    dataTransfer: {
      files: [],
      getData: (type) => {
        if (type === 'text/uri-list') {
          return 'file:///C:/Users/yunxin/notes.txt\r\n# comment';
        }
        return '';
      },
    },
    getPathForFile: () => '',
    platform: 'win32',
  });

  assertEqual(droppedPaths, ['C:\\Users\\yunxin\\notes.txt']);
});

test('extractDroppedPaths falls back to path-like text/plain payloads', () => {
  const droppedPaths = extractDroppedPaths({
    dataTransfer: {
      files: [],
      getData: (type) => (type === 'text/plain' ? 'C:\\Users\\yunxin\\notes.txt' : ''),
    },
    getPathForFile: () => '',
    platform: 'win32',
  });

  assertEqual(droppedPaths, ['C:\\Users\\yunxin\\notes.txt']);
});

test('extractDroppedPaths ignores plain text that is not a filesystem path', () => {
  const droppedPaths = extractDroppedPaths({
    dataTransfer: {
      files: [],
      getData: (type) => (type === 'text/plain' ? 'dragged note contents' : ''),
    },
    getPathForFile: () => '',
    platform: 'win32',
  });

  assertEqual(droppedPaths, []);
});

test('hasSupportedPathDropType recognizes file and URI drag types', () => {
  assertTrue(hasSupportedPathDropType({ types: ['Files'] }), 'Files should be accepted');
  assertTrue(hasSupportedPathDropType({ types: ['text/uri-list'] }), 'URI lists should be accepted');
  assertTrue(hasSupportedPathDropType({ types: ['text/plain'] }), 'Plain text path drags should be accepted');
  assertTrue(!hasSupportedPathDropType({ types: ['text/html'] }), 'Unrelated drag types should be rejected');
});

// =============================================================================
// Tests: Terminal setup
// =============================================================================

console.log('\n--- terminal setup ---\n');

test('terminal can be created with allowProposedApi', () => {
  const terminal = createTestTerminal();
  assertTrue(terminal !== null, 'Terminal should be created');
  terminal.dispose();
});

test('terminal has buffer API', () => {
  const terminal = createTestTerminal();
  assertTrue(terminal.buffer !== undefined, 'buffer should exist');
  assertTrue(terminal.buffer.active !== undefined, 'active buffer should exist');
  terminal.dispose();
});

// =============================================================================
// Tests: Writing and reading buffer
// =============================================================================

console.log('\n--- buffer read/write ---\n');

test('can write text to terminal', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'hello world');
  const line = terminal.buffer.active.getLine(0);
  assertTrue(line !== undefined, 'Line 0 should exist');
  terminal.dispose();
});

test('can read text from buffer line', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'test_var');
  const line = terminal.buffer.active.getLine(0);
  const text = line.translateToString().trim();
  assertTrue(text.includes('test_var'), `Should contain test_var, got: "${text}"`);
  terminal.dispose();
});

test('cursor position updates after write', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'abc');
  const cursorX = terminal.buffer.active.cursorX;
  assertTrue(cursorX >= 3, `Cursor should be at least 3, got: ${cursorX}`);
  terminal.dispose();
});

test('newline moves cursor to next row', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'line1\r\nline2');
  const cursorY = terminal.buffer.active.cursorY;
  assertTrue(cursorY >= 1, `Cursor Y should be at least 1, got: ${cursorY}`);
  terminal.dispose();
});

// =============================================================================
// Tests: Marker and Decoration APIs
// =============================================================================

console.log('\n--- marker/decoration APIs ---\n');

test('can register marker', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'test line\r\n');
  const marker = terminal.registerMarker(0);
  assertTrue(marker !== undefined, 'Marker should be created');
  marker.dispose();
  terminal.dispose();
});

test('marker tracks line position', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'test line\r\n');
  const marker = terminal.registerMarker(0);
  assertTrue(typeof marker.line === 'number', 'Marker should have line property');
  marker.dispose();
  terminal.dispose();
});

test('can register decoration', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'test line\r\n');
  const marker = terminal.registerMarker(0);

  const decoration = terminal.registerDecoration({
    marker,
    x: 0,
    width: 4,
  });

  assertTrue(decoration !== undefined, 'Decoration should be created');
  decoration.dispose();
  marker.dispose();
  terminal.dispose();
});

test('decoration without allowProposedApi throws', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    // NOT setting allowProposedApi
  });
  terminal.open(container);
  await writeAndWait(terminal, 'test\r\n');

  let threw = false;
  try {
    const marker = terminal.registerMarker(0);
    terminal.registerDecoration({ marker, x: 0, width: 4 });
  } catch (e) {
    threw = true;
    assertTrue(e.message.includes('allowProposedApi'),
      `Error should mention allowProposedApi, got: ${e.message}`);
  }

  assertTrue(threw, 'Should throw without allowProposedApi');
  terminal.dispose();
  container.remove();
});

// =============================================================================
// Tests: Our decoration logic with real xterm
// =============================================================================

console.log('\n--- decoration logic integration ---\n');

// Import our pattern definitions (duplicated for isolation)
const patterns = [
  {
    name: 'underscore_symbol',
    regex: /\b_[a-zA-Z0-9_]+\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*\b/g,
  },
  {
    name: 'file_line',
    regex: /[a-zA-Z0-9_.\/-]+\.[a-zA-Z]+:\d+/g,
  },
];

function parseRow(text) {
  const matches = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      matches.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        patternName: pattern.name,
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function getLogicalLineStart(buffer, row) {
  let currentRow = Math.max(0, row);
  while (currentRow > 0) {
    const line = buffer.getLine(currentRow);
    if (!line || !line.isWrapped) break;
    currentRow--;
  }
  return currentRow;
}

function getLogicalLineText(buffer, row) {
  const startRow = getLogicalLineStart(buffer, row);
  const parts = [];
  let currentRow = startRow;

  while (currentRow < buffer.length) {
    const line = buffer.getLine(currentRow);
    if (!line) break;
    parts.push(line.translateToString());
    currentRow++;
    const nextLine = buffer.getLine(currentRow);
    if (!nextLine || !nextLine.isWrapped) break;
  }

  return { startRow, text: parts.join('') };
}

test('finds pattern in terminal buffer', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'Error in my_func at src/foo.ts:42\r\n');

  const line = terminal.buffer.active.getLine(0);
  const text = line.translateToString();
  const matches = parseRow(text);

  assertEqual(matches.length, 2, 'Should find 2 matches');
  assertEqual(matches[0].text, 'my_func');
  assertEqual(matches[1].text, 'src/foo.ts:42');

  terminal.dispose();
});

test('creates decorations for matches in buffer', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'check my_var here\r\n');

  const line = terminal.buffer.active.getLine(0);
  const text = line.translateToString();
  const matches = parseRow(text);

  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, 'my_var');

  // Create decoration like our real code does
  const marker = terminal.registerMarker(-terminal.buffer.active.cursorY);
  const decoration = terminal.registerDecoration({
    marker,
    x: matches[0].start,
    width: matches[0].text.length,
  });

  assertTrue(decoration !== undefined, 'Decoration should be created');

  decoration.dispose();
  marker.dispose();
  terminal.dispose();
});

test('wrapped continuation rows still resolve file matches from the logical line start', async () => {
  const terminal = createTestTerminal({ cols: 12, rows: 4 });
  await writeAndWait(terminal, 'prefix src/foo.ts:42 suffix\r\n');

  const buffer = terminal.buffer.active;
  let wrappedRow = null;
  for (let row = 1; row < buffer.length; row++) {
    if (buffer.getLine(row)?.isWrapped) {
      wrappedRow = row;
      break;
    }
  }

  assertTrue(wrappedRow !== null, 'Fixture should wrap onto a continuation row');

  const { startRow, text } = getLogicalLineText(buffer, wrappedRow);
  const matches = parseRow(text);

  assertEqual(startRow, 0, 'Wrapped row should backtrack to the logical line start');
  assertTrue(matches.some((match) => match.patternName === 'file_line'), 'Wrapped logical line should still expose file matches');

  terminal.dispose();
});

test('cursor position filtering works', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'line with my_var\r\n');
  await writeAndWait(terminal, 'another line\r\n');
  await writeAndWait(terminal, 'cursor here');

  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;

  // Row 0 should be processable (above cursor)
  assertTrue(0 < cursorRow, `Row 0 should be above cursor (cursorRow=${cursorRow})`);

  // Cursor row should not be processable
  assertTrue(cursorRow >= 2, `Cursor should be at row 2+, got ${cursorRow}`);

  terminal.dispose();
});

// =============================================================================
// Tests: trimToContent logic
// =============================================================================

console.log('\n--- trimToContent logic ---\n');

// Helper: apply the same trim logic as createDecoration
function trimToContent(buffer, row, col, width, cols) {
  let adjustedCol = col;
  let adjustedWidth = Math.min(width, cols - col);

  const trimLine = buffer.getLine(row);
  if (trimLine) {
    const matchEnd = col + adjustedWidth;

    const isMeaningful = (cell) => {
      if (!cell) return false;
      if (cell.getChars().trim() !== '') return true;
      if (!cell.isFgDefault() || !cell.isBgDefault()) return true;
      return false;
    };

    let firstContent = matchEnd;
    for (let c = col; c < matchEnd; c++) {
      if (isMeaningful(trimLine.getCell(c))) { firstContent = c; break; }
    }

    let lastContent = firstContent;
    for (let c = matchEnd - 1; c >= firstContent; c--) {
      if (isMeaningful(trimLine.getCell(c))) { lastContent = c; break; }
    }

    if (firstContent < matchEnd) {
      adjustedCol = firstContent;
      adjustedWidth = lastContent - firstContent + 1;
    }
  }

  return { col: adjustedCol, width: adjustedWidth };
}

test('trims leading plain whitespace', async () => {
  const terminal = createTestTerminal();
  // Simulate "    hello" — 4 spaces then text
  await writeAndWait(terminal, '    hello');

  const result = trimToContent(terminal.buffer.active, 0, 0, 9, terminal.cols);
  assertEqual(result.col, 4, 'Should start at col 4 (skip 4 spaces)');
  assertEqual(result.width, 5, 'Should span 5 chars (hello)');

  terminal.dispose();
});

test('trims trailing plain whitespace', async () => {
  const terminal = createTestTerminal();
  // "hello" then spaces fill rest of 80-col line
  await writeAndWait(terminal, 'hello');

  const result = trimToContent(terminal.buffer.active, 0, 0, 20, terminal.cols);
  assertEqual(result.col, 0, 'Should start at col 0');
  assertEqual(result.width, 5, 'Should span 5 chars (hello)');

  terminal.dispose();
});

test('trims both leading and trailing whitespace', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, '    code here   ');

  // Match spans full 16 chars
  const result = trimToContent(terminal.buffer.active, 0, 0, 16, terminal.cols);
  assertEqual(result.col, 4, 'Should start at first non-space');
  assertEqual(result.width, 9, 'Should span "code here"');

  terminal.dispose();
});

test('keeps colored spaces (non-default foreground)', async () => {
  const terminal = createTestTerminal();
  // ESC[32m = green foreground, ESC[0m = reset
  // Write: "  " (plain) + "\x1b[32m + \x1b[0m" (green '+') + "  " (plain)
  await writeAndWait(terminal, '  \x1b[32m+\x1b[0m  ');

  const result = trimToContent(terminal.buffer.active, 0, 0, 5, terminal.cols);
  assertEqual(result.col, 2, 'Should start at the colored +');
  assertEqual(result.width, 1, 'Should span just the colored char');

  terminal.dispose();
});

test('keeps colored trailing spaces (non-default background)', async () => {
  const terminal = createTestTerminal();
  // "AB" in default + 3 spaces with green background
  await writeAndWait(terminal, 'AB\x1b[42m   \x1b[0m');

  const result = trimToContent(terminal.buffer.active, 0, 0, 5, terminal.cols);
  assertEqual(result.col, 0, 'Should start at col 0');
  assertEqual(result.width, 5, 'Should include colored trailing spaces');

  terminal.dispose();
});

test('no-op when entire match is meaningful', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'abcdef');

  const result = trimToContent(terminal.buffer.active, 0, 0, 6, terminal.cols);
  assertEqual(result.col, 0);
  assertEqual(result.width, 6);

  terminal.dispose();
});

test('handles all-blank match gracefully', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, '          ');

  // All spaces, no meaningful content — should keep original bounds
  const result = trimToContent(terminal.buffer.active, 0, 0, 10, terminal.cols);
  // firstContent would equal matchEnd, so original bounds are kept
  assertEqual(result.col, 0, 'Falls back to original col');
  assertEqual(result.width, 10, 'Falls back to original width');

  terminal.dispose();
});

test('respects match offset (col > 0)', async () => {
  const terminal = createTestTerminal();
  await writeAndWait(terminal, 'prefix   content   ');

  // Trim within col 6..19 — should find "content" at col 9
  const result = trimToContent(terminal.buffer.active, 0, 6, 13, terminal.cols);
  assertEqual(result.col, 9, 'Should skip spaces after prefix');
  assertEqual(result.width, 7, 'Should span "content"');

  terminal.dispose();
});

// =============================================================================
// Run all tests
// =============================================================================

runTests().then(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
});
