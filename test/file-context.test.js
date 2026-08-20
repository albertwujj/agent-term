// File context backward-scan tests
// Tests extractFileContextFromLine() and backward scan over line arrays
// Run with: node test/file-context.test.js

// =============================================================================
// Test Framework
// =============================================================================

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function runTests() {
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`\u2713 ${name}`);
      passed++;
    } catch (e) {
      console.log(`\u2717 ${name}`);
      console.log(`  ${e.message}`);
      failed++;
    }
  }
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
}

// =============================================================================
// Core logic (duplicated from renderer.js for testing)
// =============================================================================

const SOURCE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|css|scss|sass|less|sql|html|htm|xml|json|yaml|yml|toml|ini|cfg|md|txt|rst)$/i;

const FILE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|class|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|json|xml|yaml|yml|toml|ini|cfg|md|txt|rst|html|htm|css|scss|sass|less|sql|r|d|f|f90|m|mm|lua|tcl|v|sv|vhd|vhdl|zig|nim|cr|ex|exs|erl|hrl|hs|ml|mli|fs|fsi|clj|cljs|elm|dart|jl|groovy|gradle|cmake|coffee|vue|svelte|astro|wasm|proto|csv|tsv|env|conf|graphql|gql|avro|parquet|pdf|doc|docx|xls|xlsx|ppt|pptx|rtf|tex|epub|png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|tif|mp3|mp4|wav|avi|mov|mkv|flac|ogg|webm|zip|tar|gz|bz2|xz|rar|7z|tgz|zst|so|dll|dylib|a|o|obj|lib|exe|bin|dmg|iso|deb|rpm|msi|whl|egg|gem|jar|war|pdb|map|log|lock|bak|tmp|old|orig)$/i;
const DISPLAY_PATH_PREFIX = /^(?:\.\.\.|…)(?:[\\/]+|[^\\/]+[\\/]+)/;
const TRAILING_PATH_PUNCTUATION = /[.,;:!?]+$/;

function normalizeNavigablePath(text) {
  if (!text) return null;
  let normalized = text.replace(DISPLAY_PATH_PREFIX, '');
  normalized = normalized.replace(TRAILING_PATH_PUNCTUATION, '');
  return normalized || null;
}

function isLikelyFilePath(text) {
  if (SOURCE_EXTENSIONS.test(text)) return true;
  if (!text.includes('/')) return false;
  if (text.length < 3) return false;
  return FILE_EXTENSIONS.test(text) || /^\.{0,2}\//.test(text)
    || text.split('/').length >= 4;
}

const _fcHeaderRegex = /(?:Update|Create)\(([^)]+)\)/;
const _fcPythonTB = /File "([^"]+)"/;
const _fcGithubLine = /([a-zA-Z0-9_./…-]+)#L\d+/;
const _fcParenLine = /([a-zA-Z0-9_./…-]+)\(\d+\)/;
const _fcFileLineCol = /([a-zA-Z0-9_./:…-]+):\d+:\d+/;
const _fcFileLine = /([a-zA-Z0-9_./:…-]+):\d+/;
const _fcBareToken = /[a-zA-Z0-9_./…-]+/g;
const _fcVersionLike = /^v?\d+\.\d+/;
const _fcTrailingLineRefBridge = /^\s*(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)*\s*(?:in|of)\s+["'`]?$/i;
const _fcEditStats = /\s\+\d+(?:\s+-\d+)?(?:\s|[│┃|▎]|$)/;

function extractFileContextFromLine(text) {
  let m = _fcHeaderRegex.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized) return normalized;
  }

  m = _fcPythonTB.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcGithubLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcParenLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcFileLineCol.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  m = _fcFileLine.exec(text);
  if (m) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) return normalized;
  }

  _fcBareToken.lastIndex = 0;
  while ((m = _fcBareToken.exec(text)) !== null) {
    const normalized = normalizeNavigablePath(m[0]);
    if (normalized && !_fcVersionLike.test(normalized) && isLikelyFilePath(normalized)) return normalized;
  }

  return null;
}

function extractAllFileContexts(text) {
  const results = [];
  const seenEnds = new Set();

  function add(path, start, end) {
    if (seenEnds.has(end)) return;
    seenEnds.add(end);
    results.push({ path, start, end });
  }

  let m;

  for (m of text.matchAll(/(?:Update|Create)\(([^)]+)\)/g)) {
    const start = m.index + m[0].indexOf(m[1]);
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized) add(normalized, start, start + m[1].length);
  }

  for (m of text.matchAll(/File "([^"]+)"/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./…-]+)#L\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./…-]+)\(\d+\)/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./:…-]+):\d+:\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/([a-zA-Z0-9_./:…-]+):\d+/g)) {
    const normalized = normalizeNavigablePath(m[1]);
    if (normalized && isLikelyFilePath(normalized)) {
      const start = m.index + m[0].indexOf(m[1]);
      add(normalized, start, start + m[1].length);
    }
  }

  for (m of text.matchAll(/(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*/g)) {
    const normalized = normalizeNavigablePath(m[0]);
    if (normalized && !_fcVersionLike.test(normalized) && isLikelyFilePath(normalized)) {
      add(normalized, m.index, m.index + m[0].length);
    }
  }

  return results;
}

function isExplicitDirectoryPath(path) {
  if (!path || !path.includes('/')) return false;
  if (!/^(?:\/|~\/|\.{1,2}\/)/.test(path)) return false;
  return !FILE_EXTENSIONS.test(path);
}

function joinDirectoryAndRelativePath(directory, relativePath) {
  if (!directory || !relativePath) return relativePath || directory;
  if (/^(?:\/|~\/|[a-zA-Z]:[\\/])/.test(relativePath)) return relativePath;
  return `${directory.replace(/[\\/]+$/, '')}/${relativePath.replace(/^[\\/]+/, '')}`;
}

function extractSplitEditDirectory(text) {
  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (isExplicitDirectoryPath(ctx.path)) return ctx.path;
  }
  return null;
}

function extractSplitEditFile(text) {
  if (!_fcEditStats.test(text)) return null;
  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (FILE_EXTENSIONS.test(ctx.path)) return ctx.path;
  }
  return null;
}

function findSplitEditFileContextInLines(lines, directoryRow) {
  const directory = extractSplitEditDirectory(lines[directoryRow]);
  if (!directory) return null;

  for (let r = directoryRow - 1; r >= Math.max(0, directoryRow - 3); r--) {
    const filePath = extractSplitEditFile(lines[r]);
    if (filePath) return joinDirectoryAndRelativePath(directory, filePath);
  }

  return null;
}

function findTrailingLineRefFileContextInLine(text, charOffset) {
  if (charOffset == null) return null;
  const contexts = extractAllFileContexts(text);
  for (const ctx of contexts) {
    if (ctx.start < charOffset) continue;
    const bridge = text.substring(charOffset, ctx.start);
    if (_fcTrailingLineRefBridge.test(bridge)) return ctx.path;
  }
  return null;
}

// Simulate backward scan: given lines array, scan backward from startRow
// When charOffset is provided, uses position-aware resolution on the start row.
function findFileContextFromLines(lines, startRow, charOffset) {
  for (let r = startRow; r >= Math.max(0, startRow - 200); r--) {
    if (r === startRow && charOffset != null) {
      const contexts = extractAllFileContexts(lines[r]);
      let best = null;
      for (const ctx of contexts) {
        if (ctx.end <= charOffset && (best === null || ctx.end > best.end)) {
          best = ctx;
        }
      }
      if (best) return best.path;
    } else {
      const splitEditContext = findSplitEditFileContextInLines(lines, r);
      if (splitEditContext) return splitEditContext;

      const result = extractFileContextFromLine(lines[r]);
      if (result) return result;
    }
  }
  return null;
}

function resolveLineRefFileContextFromLines(lines, startRow, lineRefStart, lineRefEnd) {
  const sameLine = findTrailingLineRefFileContextInLine(lines[startRow], lineRefEnd);
  if (sameLine) return sameLine;
  return findFileContextFromLines(lines, startRow, lineRefStart);
}

// =============================================================================
// Tests: extractFileContextFromLine — single line
// =============================================================================

console.log('\n--- extractFileContextFromLine ---\n');

// Diff headers

test('diff header: Update(path)', () => {
  assertEqual(extractFileContextFromLine('  Update(src/models.py)'), 'src/models.py');
});

test('diff header: Create(path)', () => {
  assertEqual(extractFileContextFromLine('  Create(lib/new_module.py)'), 'lib/new_module.py');
});

// Python traceback

test('python traceback: File "path"', () => {
  assertEqual(extractFileContextFromLine('  File "/usr/lib/python3/foo.py", line 42, in func'), '/usr/lib/python3/foo.py');
});

// GitHub line

test('github line: path#L123', () => {
  assertEqual(extractFileContextFromLine('  src/utils.py#L42'), 'src/utils.py');
});

// Paren line

test('paren line: path(123)', () => {
  assertEqual(extractFileContextFromLine('  src/utils.py(42)'), 'src/utils.py');
});

// File:line:col

test('file:line:col pattern', () => {
  assertEqual(extractFileContextFromLine('  src/main.ts:10:5 error TS1234'), 'src/main.ts');
});

// File:line

test('file:line pattern', () => {
  assertEqual(extractFileContextFromLine('  src/models.py:42'), 'src/models.py');
});

test('file:line with absolute path', () => {
  assertEqual(extractFileContextFromLine('  /Users/dev/project/src/main.py:100'), '/Users/dev/project/src/main.py');
});

test('file:line with relative path', () => {
  assertEqual(extractFileContextFromLine('  ../lib/utils.py:5'), '../lib/utils.py');
});

// Bare file paths

test('bare filename with known extension', () => {
  assertEqual(extractFileContextFromLine('  1. Deferred write pattern in bsr_request_tracker.py (most important)'), 'bsr_request_tracker.py');
});

test('bare path with slash but no extension → null', () => {
  assertEqual(extractFileContextFromLine('  Changes in src/components/Button'), null);
});

test('bare filename: renderer.js', () => {
  assertEqual(extractFileContextFromLine('  The bug is in renderer.js somewhere'), 'renderer.js');
});

// Version-like filtering

test('version string v1.2.3 is not a file path', () => {
  assertEqual(extractFileContextFromLine('  Updated to v1.2.3'), null);
});

test('version string 2.0.0 is not a file path', () => {
  assertEqual(extractFileContextFromLine('  version 2.0.0 released'), null);
});

// No match

test('no file context on plain text', () => {
  assertEqual(extractFileContextFromLine('  just some plain text here'), null);
});

test('no file context on empty string', () => {
  assertEqual(extractFileContextFromLine(''), null);
});

// Non-file dotted tokens

test('dotted attribute cell.common_name is not a file', () => {
  assertEqual(extractFileContextFromLine('  cell.common_name = value'), null);
});

test('dotted method logs_writer.add_info is not a file', () => {
  assertEqual(extractFileContextFromLine('  logs_writer.add_info("msg")'), null);
});

test('chained dotted self._entries.setdefault is not a file', () => {
  assertEqual(extractFileContextFromLine('  self._bsr_skip_log_entries.setdefault(key, [])'), null);
});

// Slash-containing prose (false positive regression tests)

test('bare slash "/" is not a file path', () => {
  assertEqual(extractFileContextFromLine('  /'), null);
});

test('prose with slash "prioritized/ordered" is not a file path', () => {
  assertEqual(extractFileContextFromLine('  """ The degraded cells could be prioritized/ordered based on degradation degree. """'), null);
});

test('prose with slash "if/else" is not a file path', () => {
  assertEqual(extractFileContextFromLine('  Use if/else for branching'), null);
});

test('prose with slash "input/output" is not a file path', () => {
  assertEqual(extractFileContextFromLine('  handles input/output operations'), null);
});

// Paths with slash that SHOULD match

test('bare path with slash and extension', () => {
  assertEqual(extractFileContextFromLine('  Changes in src/components/Button.tsx'), 'src/components/Button.tsx');
});

test('bare path with slash and extension strips trailing period', () => {
  assertEqual(extractFileContextFromLine('  Changes in src/components/Button.tsx.'), 'src/components/Button.tsx');
});

test('bare path with slash and extension strips elided prefix', () => {
  assertEqual(extractFileContextFromLine('  Changes in .../src/components/Button.tsx'), 'src/components/Button.tsx');
});

test('bare path with slash and extension strips partially elided prefix segment', () => {
  const text = '  │ ...rithm/resolution/avr_rollback_rule_validator.py +15 -3 │';
  assertEqual(extractFileContextFromLine(text), 'resolution/avr_rollback_rule_validator.py');
});

test('bare path with slash and extension strips unicode partially elided prefix segment', () => {
  const text = '  │ …rithm/resolution/avr_rollback_rule_validator.py +15 -3 │';
  assertEqual(extractFileContextFromLine(text), 'resolution/avr_rollback_rule_validator.py');
});

test('Cursor Edited header exposes the edited markdown path', () => {
  assertEqual(extractFileContextFromLine('  Edited api-style-guide.md +21 -4'), 'api-style-guide.md');
});

test('Cursor Edited add-only header exposes the edited markdown path', () => {
  assertEqual(extractFileContextFromLine('  Edited api-style-guide.md +5'), 'api-style-guide.md');
});

test('absolute path is a file path', () => {
  assertEqual(extractFileContextFromLine('  /Users/dev/project/Makefile'), '/Users/dev/project/Makefile');
});

test('relative ./ path is a file path', () => {
  assertEqual(extractFileContextFromLine('  ./src/utils/helper'), './src/utils/helper');
});

test('relative ../ path is a file path', () => {
  assertEqual(extractFileContextFromLine('  ../lib/module'), '../lib/module');
});

test('deep path (4+ segments) without extension is a file path', () => {
  assertEqual(extractFileContextFromLine('  Changes in src/components/ui/Button'), 'src/components/ui/Button');
});

// =============================================================================
// Tests: priority order
// =============================================================================

console.log('\n--- priority order ---\n');

test('diff header wins over file:line on same line', () => {
  assertEqual(extractFileContextFromLine('  Update(src/new.py) see src/old.py:10'), 'src/new.py');
});

test('file:line wins over bare path on same line', () => {
  // "src/other.py:5" should match as file:line before bare "renderer.js"
  assertEqual(extractFileContextFromLine('  renderer.js see src/other.py:5'), 'src/other.py');
});

// =============================================================================
// Tests: backward scan over lines
// =============================================================================

console.log('\n--- backward scan ---\n');

test('finds file:line above symbol row', () => {
  const lines = [
    'src/models.py:42',
    '    my_helper()',
  ];
  assertEqual(findFileContextFromLines(lines, 1), 'src/models.py');
});

test('nearest row wins (backward scan)', () => {
  const lines = [
    'src/old.py:1',
    '    old_func()',
    'src/new.py:5',
    '    new_func()',
  ];
  assertEqual(findFileContextFromLines(lines, 3), 'src/new.py');
});

test('skips blank and non-matching lines', () => {
  const lines = [
    'src/models.py:10',
    '',
    '    # comment with no file reference',
    '    my_func()',
  ];
  assertEqual(findFileContextFromLines(lines, 3), 'src/models.py');
});

test('returns null when no file context in range', () => {
  const lines = [
    '  just some text',
    '  more text',
    '  my_func()',
  ];
  assertEqual(findFileContextFromLines(lines, 2), null);
});

test('diff header found through backward scan', () => {
  const lines = [
    '  Update(src/foo.js)',
    '    628 +        const x = 1;',
    '    629 +        const y = 2;',
  ];
  assertEqual(findFileContextFromLines(lines, 2), 'src/foo.js');
});

test('bare filename found through backward scan (bsr example)', () => {
  const lines = [
    '  1. Deferred write pattern in bsr_request_tracker.py (most important)',
    '',
    '  self._bsr_skip_log_entries.setdefault(cell_uid, []).append(',
    '      (msg.value, cell.common_name, cell.dn))',
    '',
    '  for cell_uid in skipped_uids:',
    '      for msg, common_name, dn in self._bsr_skip_log_entries.get(cell_uid, []):',
    '          logs_writer.add_info(msg, common_name, dn)',
  ];
  assertEqual(findFileContextFromLines(lines, 7), 'bsr_request_tracker.py');
});

test('scan includes the current row', () => {
  const lines = [
    '  no context here',
    '  src/models.py:42 and my_func()',
  ];
  // startRow=1, scan checks row 1 first — finds src/models.py
  assertEqual(findFileContextFromLines(lines, 1), 'src/models.py');
});

test('file path on same line as line_ref (bare path + "(lines N-M)")', () => {
  const lines = [
    '  some unrelated context',
    '  modules/SearchIndex/SI/tasks/task_jobs.py (lines 164-171)',
  ];
  // The file path is on the same row as the "lines 164-171" reference
  assertEqual(findFileContextFromLines(lines, 1), 'modules/SearchIndex/SI/tasks/task_jobs.py');
});

test('split edit header joins filename row with following directory row', () => {
  const lines = [
    '│ rule_evaluator.py +6 -9 │',
    '│ /home/dev/project/modules/Search/query_engine/rate_limit │',
    '│  23 +   "allowed_rules", "rule_set", "add_report_entry", │',
  ];
  assertEqual(
    findFileContextFromLines(lines, 2),
    '/home/dev/project/modules/Search/query_engine/rate_limit/rule_evaluator.py',
  );
});

test('split edit header beats bare directory context', () => {
  const lines = [
    '  rule_evaluator.py +6 -9',
    '  /home/dev/project/modules/Search/query_engine/rate_limit',
    '      23 +   "allowed_rules", "rule_set", "add_report_entry",',
  ];
  assertEqual(
    findFileContextFromLines(lines, 2),
    '/home/dev/project/modules/Search/query_engine/rate_limit/rule_evaluator.py',
  );
});

test('split edit add-only header joins filename row with following directory row', () => {
  const lines = [
    '  api-style-guide.md +5',
    '  /home/dev/project/ai',
    '    ▎+ ### Preview before posting',
  ];
  assertEqual(
    findFileContextFromLines(lines, 2),
    '/home/dev/project/ai/api-style-guide.md',
  );
});

test('split edit header does not join directory with filename lacking edit stats', () => {
  const lines = [
    '  rule_evaluator.py',
    '  /home/dev/project/modules/Search/query_engine/rate_limit',
    '      23 +   "allowed_rules", "rule_set", "add_report_entry",',
  ];
  assertEqual(
    findFileContextFromLines(lines, 2),
    '/home/dev/project/modules/Search/query_engine/rate_limit',
  );
});

// =============================================================================
// Tests: extractAllFileContexts — collects all candidates
// =============================================================================

console.log('\n--- extractAllFileContexts ---\n');

test('finds two bare file paths on one line', () => {
  const results = extractAllFileContexts('a.py (line 1 - 10), b.py (line 1 - 10)');
  const paths = results.map(r => r.path);
  assertEqual(paths.includes('a.py'), true, 'should contain a.py');
  assertEqual(paths.includes('b.py'), true, 'should contain b.py');
});

test('finds two file:line patterns on one line', () => {
  const results = extractAllFileContexts('a.py:10 see also b.py:20');
  const paths = results.map(r => r.path);
  assertEqual(paths.includes('a.py'), true, 'should contain a.py');
  assertEqual(paths.includes('b.py'), true, 'should contain b.py');
});

test('file context spans track the file path token', () => {
  const text = 'a.py:10 see also b.py:20';
  const results = extractAllFileContexts(text);
  const aCtx = results.find(r => r.path === 'a.py');
  const bCtx = results.find(r => r.path === 'b.py');
  assertEqual(aCtx.start, text.indexOf('a.py'), 'a.py start at file token');
  assertEqual(aCtx.end <= text.indexOf('see'), true, 'a.py end before "see"');
  assertEqual(bCtx.start, text.indexOf('b.py'), 'b.py start at file token');
  assertEqual(bCtx.end, bCtx.start + 'b.py'.length, 'b.py end after file token');
});

// =============================================================================
// Tests: position-aware backward scan
// =============================================================================

console.log('\n--- position-aware backward scan ---\n');

test('two bare paths: first line_ref resolves to a.py', () => {
  const line = 'a.py (line 1 - 10), b.py (line 1 - 10)';
  const lines = [line];
  // Click on first "line 1" — offset is inside "(line 1"
  const firstLineRef = line.indexOf('line 1');
  assertEqual(findFileContextFromLines(lines, 0, firstLineRef), 'a.py');
});

test('two bare paths: second line_ref resolves to b.py', () => {
  const line = 'a.py (line 1 - 10), b.py (line 1 - 10)';
  const lines = [line];
  // Click on second "line 1" — offset is inside the second "(line 1"
  const secondLineRef = line.lastIndexOf('line 1');
  assertEqual(findFileContextFromLines(lines, 0, secondLineRef), 'b.py');
});

test('two file:line patterns: position picks correct one', () => {
  const line = 'a.py:10 see also b.py:20';
  const lines = [line];
  // Click after b.py:20
  const offset = line.indexOf('b.py:20') + 'b.py:20'.length + 1;
  assertEqual(findFileContextFromLines(lines, 0, offset), 'b.py');
});

test('no file path before click offset falls through to previous row', () => {
  const lines = [
    'src/fallback.py:1',
    '  (line 5) then a.py',
  ];
  // Click on "line 5" at start of line — no file path before it
  const offset = lines[1].indexOf('line 5');
  assertEqual(findFileContextFromLines(lines, 1, offset), 'src/fallback.py');
});

test('compact Claude read range resolves file from previous path row', () => {
  const lines = [
    'Read meta_data_cache.py',
    '  │ modules/SearchIndex/SI/meta_data_cache/meta_data_cache.py',
    '  └ L20:105 (85 lines read)',
  ];
  const start = lines[2].indexOf('L20:105');
  const end = start + 'L20:105'.length;
  assertEqual(
    resolveLineRefFileContextFromLines(lines, 2, start, end),
    'modules/SearchIndex/SI/meta_data_cache/meta_data_cache.py',
  );
});

// =============================================================================
// Tests: trailing file context for line references
// =============================================================================

console.log('\n--- trailing line_ref file context ---\n');

test('line_ref resolves trailing filename introduced by "in"', () => {
  const line = '1. The resolver skips when both actions fail (line 116 in conflict_finder.py).';
  const start = line.indexOf('line 116');
  const end = start + 'line 116'.length;
  assertEqual(resolveLineRefFileContextFromLines([line], 0, start, end), 'conflict_finder.py');
});

test('line_ref resolves quoted trailing filename', () => {
  const line = 'See line 116 in `conflict_finder.py` for the skip outcome.';
  const start = line.indexOf('line 116');
  const end = start + 'line 116'.length;
  assertEqual(resolveLineRefFileContextFromLines([line], 0, start, end), 'conflict_finder.py');
});

test('continuation ranges resolve trailing filename for each sub-match', () => {
  const line = 'retrigger flow: lines 167-175, 200-205 in retrigger.py';
  const firstStart = line.indexOf('167-175');
  const firstEnd = firstStart + '167-175'.length;
  const secondStart = line.indexOf('200-205');
  const secondEnd = secondStart + '200-205'.length;
  assertEqual(resolveLineRefFileContextFromLines([line], 0, firstStart, firstEnd), 'retrigger.py');
  assertEqual(resolveLineRefFileContextFromLines([line], 0, secondStart, secondEnd), 'retrigger.py');
});

test('trailing lookup does not steal unrelated later filenames', () => {
  const lines = [
    'src/fallback.py:1',
    '  line 42 then later mention random.py',
  ];
  const start = lines[1].indexOf('line 42');
  const end = start + 'line 42'.length;
  assertEqual(resolveLineRefFileContextFromLines(lines, 1, start, end), 'src/fallback.py');
});

// =============================================================================
// Run all tests
// =============================================================================

runTests();
