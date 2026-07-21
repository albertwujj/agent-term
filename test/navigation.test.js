const {
  buildResolveFileRequest,
  getCaretDiagnostics,
  getCaretPosition,
  isAbsoluteFilePath,
  shouldQueryBackendForCaretPath,
  navigateToFile,
  navigateToSymbol,
} = require('../src/navigation');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
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

function createRequestStub(responses) {
  const calls = [];
  return {
    calls,
    async sendNavigationRequest(request, port) {
      calls.push({ request, port: port == null ? 'backend' : port });
      return responses.shift();
    },
  };
}

console.log('\n--- navigation ---\n');

test('plain file click omits line and matchText and does not scroll', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: '/project/foo.py' },
  ]);

  const result = await navigateToFile({
    filePath: 'foo.py',
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
  });

  assertEqual(stub.calls, [
    { request: { type: 'file', path: 'foo.py' }, port: 'backend' },
  ], 'Plain file click should only send the backend file request');
  assertEqual(result, { status: 'ok', file: '/project/foo.py' }, 'Plain file click should not add scroll metadata');
});

test('explicit file+line still triggers frontend scroll', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: '/project/foo.py', line: 42, column: 0 },
    { status: 'ok' },
  ]);

  const result = await navigateToFile({
    filePath: 'foo.py',
    line: 42,
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
  });

  assertEqual(stub.calls, [
    { request: { type: 'file', path: 'foo.py', line: 42 }, port: 'backend' },
    { request: { action: 'scroll', file: '/project/foo.py', line: 42, column: 0 }, port: 8766 },
  ], 'Explicit file+line navigation should still scroll');
  assertEqual(result, {
    status: 'ok',
    file: '/project/foo.py',
    line: 42,
    column: 0,
    scrollRequest: { action: 'scroll', file: '/project/foo.py', line: 42, column: 0 },
    scrollResponse: { status: 'ok' },
  });
});

test('explicit file+matchText still triggers frontend scroll', async () => {
  const stub = createRequestStub([
    { status: 'text_moved', file: '/project/foo.py', line: 84, column: 0 },
    { status: 'ok' },
  ]);

  const result = await navigateToFile({
    filePath: 'foo.py',
    matchText: 'def foo():',
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
  });

  assertEqual(stub.calls, [
    { request: { type: 'file', path: 'foo.py', matchText: 'def foo():' }, port: 'backend' },
    { request: { action: 'scroll', file: '/project/foo.py', line: 84, column: 0 }, port: 8766 },
  ], 'Explicit file+matchText navigation should still scroll');
  assertEqual(result, {
    status: 'text_moved',
    file: '/project/foo.py',
    line: 84,
    column: 0,
    scrollRequest: { action: 'scroll', file: '/project/foo.py', line: 84, column: 0 },
    scrollResponse: { status: 'ok' },
  });
});

test('symbol navigation still triggers frontend scroll', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: '/project/foo.py', line: 21, column: 3 },
    { status: 'ok' },
  ]);

  const result = await navigateToSymbol({
    symbolName: 'myFunction',
    fileHint: 'foo.py',
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
  });

  assertEqual(stub.calls, [
    { request: { type: 'symbol', name: 'myFunction', fileHint: 'foo.py' }, port: 'backend' },
    { request: { action: 'scroll', file: '/project/foo.py', line: 21, column: 3 }, port: 8766 },
  ], 'Symbol navigation should still scroll');
  assertEqual(result, {
    status: 'ok',
    file: '/project/foo.py',
    line: 21,
    column: 3,
    scrollRequest: { action: 'scroll', file: '/project/foo.py', line: 21, column: 3 },
    scrollResponse: { status: 'ok' },
  });
});

test('caret position prefers backend relative path for absolute frontend file', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: '/project/foo.py', line: 21, column: 3, matchText: 'print("hi")' },
    { status: 'ok', file: '/project/foo.py', relativePath: 'foo.py', line: 21, column: 3 },
  ]);

  const result = await getCaretPosition({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
    backendPort: 8765,
  });

  assertEqual(stub.calls, [
    { request: { action: 'caret' }, port: 8766 },
    { request: { type: 'resolve_file', path: '/project/foo.py', matchText: 'print("hi")' }, port: 8765 },
  ], 'Absolute frontend caret paths should be reformatted through the backend plugin');
  assertEqual(result, { status: 'ok', file: 'foo.py', line: 21, column: 3, matchText: 'print("hi")' });
});

test('caret position resolves relative frontend path through backend', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: 'src/foo.py', line: 21, column: 3, matchText: 'print("hi")' },
    { status: 'ok', file: '/project/src/foo.py', relativePath: 'src/foo.py', line: 21, column: 3 },
  ]);

  const result = await getCaretPosition({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
    backendPort: 8765,
  });

  assertEqual(stub.calls, [
    { request: { action: 'caret' }, port: 8766 },
    { request: { type: 'resolve_file', path: 'src/foo.py', matchText: 'print("hi")' }, port: 8765 },
  ], 'Relative frontend caret paths should be resolved through the backend plugin');
  assertEqual(result, { status: 'ok', file: 'src/foo.py', line: 21, column: 3, matchText: 'print("hi")' });
});

test('caret position uses backend line resolved from diff anchor candidates', async () => {
  const stub = createRequestStub([
    {
      status: 'ok',
      file: 'gradle.properties',
      line: null,
      column: 0,
      matchText: 'pluginVersion = 1.0.1',
      matchTextCandidates: [
        'pluginVersion = 1.0.1',
        'pluginVersion = 1.0.5',
        'pluginName = IntelliJ Navigator Frontend',
      ],
    },
    {
      status: 'ok',
      file: '/project/frontend-plugin/gradle.properties',
      relativePath: 'frontend-plugin/gradle.properties',
      line: 4,
      column: 0,
    },
  ]);

  const result = await getCaretPosition({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
    backendPort: 8765,
  });

  assertEqual(stub.calls, [
    { request: { action: 'caret' }, port: 8766 },
    {
      request: {
        type: 'resolve_file',
        path: 'gradle.properties',
        matchText: 'pluginVersion = 1.0.1',
        matchTextCandidates: [
          'pluginVersion = 1.0.1',
          'pluginVersion = 1.0.5',
          'pluginName = IntelliJ Navigator Frontend',
        ],
      },
      port: 8765,
    },
  ], 'Diff caret resolution should pass ordered anchor candidates to the backend');
  assertEqual(result, {
    status: 'ok',
    file: 'frontend-plugin/gradle.properties',
    line: 4,
    column: 0,
    matchText: 'pluginVersion = 1.0.1',
    matchTextCandidates: [
      'pluginVersion = 1.0.1',
      'pluginVersion = 1.0.5',
      'pluginName = IntelliJ Navigator Frontend',
    ],
  });
});

test('caret position surfaces backend resolve failure', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: 'src/foo.py', line: 21, column: 3, matchText: 'print("hi")' },
    { status: 'error', message: 'multiple files match: src/foo.py', count: 2 },
  ]);

  const result = await getCaretPosition({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
    backendPort: 8765,
  });

  assertEqual(result, {
    status: 'error',
    message: 'multiple files match: src/foo.py',
    count: 2,
  });
});

test('caret position falls back to absolute frontend path when backend reformat fails', async () => {
  const stub = createRequestStub([
    { status: 'ok', file: '/project/foo.py', line: 21, column: 3, matchText: 'print("hi")' },
    { status: 'not_found', message: 'file not found' },
  ]);

  const result = await getCaretPosition({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
    backendPort: 8765,
  });

  assertEqual(result, {
    status: 'ok',
    file: '/project/foo.py',
    line: 21,
    column: 3,
    matchText: 'print("hi")',
  });
});

test('caret diagnostics requests only query the frontend plugin', async () => {
  const stub = createRequestStub([
    { status: 'ok', message: 'selectedEditor=com.jetbrains.thinclient.vcs.FrontendDefaultFileEditor' },
  ]);

  const result = await getCaretDiagnostics({
    sendNavigationRequest: stub.sendNavigationRequest,
    frontendPort: 8766,
  });

  assertEqual(stub.calls, [
    { request: { action: 'caret_diagnostics' }, port: 8766 },
  ], 'Caret diagnostics should only query the frontend plugin');
  assertEqual(result, {
    status: 'ok',
    message: 'selectedEditor=com.jetbrains.thinclient.vcs.FrontendDefaultFileEditor',
  });
});

test('absolute file path detection handles unix and windows paths', () => {
  assertEqual(isAbsoluteFilePath('/project/foo.py'), true);
  assertEqual(isAbsoluteFilePath('C:/project/foo.py'), true);
  assertEqual(isAbsoluteFilePath('src/foo.py'), false);
  assertEqual(isAbsoluteFilePath('~/project/foo.py'), false);
});

test('backend caret path query runs for absolute and relative project paths', () => {
  assertEqual(shouldQueryBackendForCaretPath('/project/foo.py'), true);
  assertEqual(shouldQueryBackendForCaretPath('C:/project/foo.py'), true);
  assertEqual(shouldQueryBackendForCaretPath('src/foo.py'), true);
  assertEqual(shouldQueryBackendForCaretPath('~/project/foo.py'), false);
});

test('buildResolveFileRequest builds backend resolve request', () => {
  assertEqual(buildResolveFileRequest('src/foo.py', { matchText: 'print("hi")' }), {
    type: 'resolve_file',
    path: 'src/foo.py',
    matchText: 'print("hi")',
  });
});

test('buildResolveFileRequest includes candidate texts when provided', () => {
  assertEqual(buildResolveFileRequest('src/foo.py', {
    matchText: 'print("hi")',
    matchTextCandidates: ['print("hi")', 'def foo():'],
  }), {
    type: 'resolve_file',
    path: 'src/foo.py',
    matchText: 'print("hi")',
    matchTextCandidates: ['print("hi")', 'def foo():'],
  });
});

runTests();
