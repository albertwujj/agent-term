const {
  getSearchNavigationState,
  getSearchCountText,
  shouldNavigateSearchResults,
} = require('../src/search-ui-state');

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

console.log('\n--- search ui state ---\n');

test('alt-screen search hides and disables navigation controls', () => {
  assertEqual(
    getSearchNavigationState({ isAltScreenSearchMode: true }),
    { disabled: true, hidden: true },
    'Alt-screen search should disable next/previous navigation',
  );
});

test('normal search keeps navigation controls available', () => {
  assertEqual(
    getSearchNavigationState({ isAltScreenSearchMode: false }),
    { disabled: false, hidden: false },
    'Normal search should keep next/previous navigation visible',
  );
});

test('alt-screen search cannot navigate even when matches exist', () => {
  assertEqual(
    shouldNavigateSearchResults({ isAltScreenSearchMode: true, matchCount: 3 }),
    false,
    'Alt-screen search should stay highlight-only',
  );
});

test('normal search can navigate when matches exist', () => {
  assertEqual(
    shouldNavigateSearchResults({ isAltScreenSearchMode: false, matchCount: 3 }),
    true,
    'Normal search should allow next/previous navigation',
  );
});

test('normal search does not navigate without matches', () => {
  assertEqual(
    shouldNavigateSearchResults({ isAltScreenSearchMode: false, matchCount: 0 }),
    false,
    'Navigation should stay disabled when there are no matches',
  );
});

test('alt-screen search shows scope text before typing', () => {
  assertEqual(
    getSearchCountText({
      isLoading: false,
      isAltScreenSearchMode: true,
      query: '',
      matchCount: 0,
      liveCount: 0,
      historyCount: 0,
      currentIndex: -1,
    }),
    'In alt screen: current screen only',
    'Alt-screen search should explain its limited scope before typing',
  );
});

test('alt-screen search shows live match count without history', () => {
  assertEqual(
    getSearchCountText({
      isLoading: false,
      isAltScreenSearchMode: true,
      query: 'copilot',
      matchCount: 4,
      liveCount: 4,
      historyCount: 0,
      currentIndex: -1,
    }),
    '4 matches • in alt screen, current screen only',
    'Alt-screen search should report only live screen matches',
  );
});

test('alt-screen search shows scoped no-results text', () => {
  assertEqual(
    getSearchCountText({
      isLoading: false,
      isAltScreenSearchMode: true,
      query: 'missing',
      matchCount: 0,
      liveCount: 0,
      historyCount: 0,
      currentIndex: -1,
    }),
    'No results • in alt screen, current screen only',
    'Alt-screen search should keep the scope explanation when nothing matches',
  );
});

test('normal search shows loading text', () => {
  assertEqual(
    getSearchCountText({
      isLoading: true,
      isAltScreenSearchMode: false,
      query: 'loading',
      matchCount: 0,
      liveCount: 0,
      historyCount: 0,
      currentIndex: -1,
    }),
    'Searching...',
    'Loading state should take precedence over result text',
  );
});

test('normal search shows history result counts', () => {
  assertEqual(
    getSearchCountText({
      isLoading: false,
      isAltScreenSearchMode: false,
      query: 'result',
      matchCount: 5,
      liveCount: 3,
      historyCount: 2,
      currentIndex: 1,
    }),
    '2 of 5 • 2 history',
    'Normal search should preserve the history-result suffix',
  );
});

runTests();
