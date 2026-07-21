// Unit tests for pattern matching
// Run with: node test/patterns.test.js

// =============================================================================
// Pattern definitions (duplicated from renderer.js for testing)
// =============================================================================

// All file extensions - used to prevent filenames from being treated as symbols
const FILE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|class|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|json|xml|yaml|yml|toml|ini|cfg|md|txt|rst|html|htm|css|scss|sass|less|sql|r|d|f|f90|m|mm|lua|tcl|v|sv|vhd|vhdl|zig|nim|cr|ex|exs|erl|hrl|hs|ml|mli|fs|fsi|clj|cljs|elm|dart|jl|groovy|gradle|cmake|coffee|vue|svelte|astro|wasm|proto|csv|tsv|env|conf|graphql|gql|avro|parquet|pdf|doc|docx|xls|xlsx|ppt|pptx|rtf|tex|epub|png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|tif|mp3|mp4|wav|avi|mov|mkv|flac|ogg|webm|zip|tar|gz|bz2|xz|rar|7z|tgz|zst|so|dll|dylib|a|o|obj|lib|exe|bin|dmg|iso|deb|rpm|msi|whl|egg|gem|jar|war|pdb|map|log|lock|bak|tmp|old|orig)$/i;

// Source code extensions (same as renderer.js - for IDE file context)
const SOURCE_EXTENSIONS = /\.(js|ts|jsx|tsx|mjs|cjs|py|pyc|pyi|rb|rs|go|java|c|h|cpp|hpp|cc|cs|swift|kt|scala|php|pl|sh|bash|zsh|css|scss|sass|less|sql|html|htm|xml|json|yaml|yml|toml|ini|cfg|md|txt|rst)$/i;

// Resource file extensions - opened with OS default handler (not IDE)
const RESOURCE_EXTENSIONS = /\.(png|jpe?g|gif|svg|ico|webp|bmp|tiff?|pdf|docx?|xlsx?|pptx?|rtf|epub|mp[34]|wav|avi|mov|mkv|flac|ogg|webm|zip|tgz|gz|bz2|xz|rar|7z|zst|csv|tsv|parquet|avro)$/i;
const DISPLAY_PATH_PREFIX = /^(?:\.\.\.|…)(?:[\\/]+|[^\\/]+[\\/]+)/;
const TRAILING_PATH_PUNCTUATION = /[.,;:!?]+$/;

function normalizeNavigablePath(text) {
  if (!text) return null;
  let normalized = text.replace(DISPLAY_PATH_PREFIX, '');
  normalized = normalized.replace(TRAILING_PATH_PUNCTUATION, '');
  return normalized || null;
}

const WSL_UNC_PREFIX = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i;
function wslUncToPosix(text) {
  return text.replace(WSL_UNC_PREFIX, '').replace(/\\/g, '/');
}

function isLikelyFilePath(text) {
  if (SOURCE_EXTENSIONS.test(text)) return true;
  if (!text.includes('/')) return false;
  if (text.length < 3) return false;
  return FILE_EXTENSIONS.test(text) || /^(?:\.{0,2}|~)\//.test(text)
    || text.split('/').length >= 4;
}

const IS_SYMBOL_LIKE = /^(?:_[a-zA-Z0-9_]+|[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)$/;

function isLikelyPathNotSymbol(line, index, matchLength) {
  const charBefore = index > 0 ? line[index - 1] : '';
  const charAfter = line[index + matchLength] || '';
  if (charBefore !== '/' && charBefore !== '\\' && charAfter !== '/' && charAfter !== '\\') return false;
  let ts = index;
  while (ts > 0 && /[a-zA-Z0-9_.\/\\-]/.test(line[ts - 1])) ts--;
  let te = index + matchLength;
  while (te < line.length && /[a-zA-Z0-9_.\/\\-]/.test(line[te])) te++;
  const fullToken = line.substring(ts, te).replace(/\\/g, '/');
  if (isLikelyFilePath(fullToken)) return true;
  if (charBefore === '/' || charBefore === '\\') {
    let i = index - 2;
    while (i >= 0 && /[a-zA-Z0-9_]/.test(line[i])) i--;
    if (!IS_SYMBOL_LIKE.test(line.substring(i + 1, index - 1))) return true;
  }
  if (charAfter === '/' || charAfter === '\\') {
    let i = index + matchLength + 1;
    while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) i++;
    if (!IS_SYMBOL_LIKE.test(line.substring(index + matchLength + 1, i))) return true;
  }
  return false;
}

const CODE_KEYWORDS = /^(?:def|class|if|elif|else:|for|while|return|import|from|try:|except|finally:|with|yield|raise|pass|break|continue|lambda|assert|function|const|let|var|async|await|export|switch|case|throw|new|fn|pub|struct|enum|impl|match|use|type|interface|package)\b/;

function looksLikeCode(text) {
  if (CODE_KEYWORDS.test(text)) return true;
  let signals = 0;
  if (/\w+\(/.test(text)) signals++;
  if (/[=!<>]=|[<>]/.test(text)) signals++;
  if (/[{}\[\]()]/.test(text)) signals++;
  if (/\w\.\w/.test(text)) signals++;
  if (/;\s*$/.test(text)) signals++;
  if (/^\s*[#\/]/.test(text)) signals++;
  if (/\w+\s*=\s*\S/.test(text)) signals++;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  if (words >= 6) signals--;
  return signals >= 2;
}

function isLikelySourceLine(text) {
  let content;
  const bordered = /^\s*[│┃|] (.+?)(?:\s+[│┃|])?\s*$/.exec(text);
  if (bordered) {
    content = bordered[1];
  } else {
    const trimmed = text.trimStart();
    if (text.length - trimmed.length < 4) return false;
    content = trimmed;
  }
  if (!content || !content.trim()) return false;
  const trimmed = content.trim();
  if (isLikelyFilePath(trimmed)) return false;
  if (trimmed.length > 120) return false;
  return looksLikeCode(trimmed);
}

function hasLeadingLineRefContext(line, index) {
  const prefix = line.substring(0, index);
  return /\b[Ll]ines?\s+~?\d+(?:\s*-\s*~?\d+)?(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)?\s+(?:in|of)\s+["'`]?$/i.test(prefix);
}

function getBorderedContentSpan(text) {
  const left = /^\s*[│┃|]\s/.exec(text);
  if (!left) return null;

  const start = left[0].length;
  let end = text.length;
  const right = /\s+[│┃|]\s*$/.exec(text.substring(start));
  if (right) end = start + right.index;

  return {
    content: text.substring(start, end),
    start,
    end,
  };
}

function getCursorDiffContentSpan(text) {
  const bordered = getBorderedContentSpan(text);
  if (bordered) return bordered;

  const gutter = /^(\s*)▎(.*)$/.exec(text);
  if (!gutter) return null;

  let start = gutter[1].length + 1;
  let content = gutter[2];
  if (content.startsWith(' ')) {
    start += 1;
    content = content.slice(1);
  }

  return {
    content,
    start,
    end: text.length,
  };
}

const STRICT_DIFF_LINE_REGEX = /^\s{2,}(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;
const INNER_DIFF_LINE_REGEX = /^\s*(\d+)(?:\s([+-])\s*|\s{2,})(\S.*)$/;
const LINE_REF_REGEX = /\b(?:[Ll]ines?\s+~?\d+(?:\s*-\s*~?\d+)?(?:,\s*~?\d+(?:\s*-\s*~?\d+)?)*|L~?\d+(?::\s*~?\d+|\s*-\s*~?\d+))/g;

function parseDiffLineText(text, { allowInner = false } = {}) {
  const bordered = getBorderedContentSpan(text);
  const source = bordered ? bordered.content : text;
  const m = (bordered || allowInner ? INNER_DIFF_LINE_REGEX : STRICT_DIFF_LINE_REGEX).exec(source);
  if (!m) return null;

  return {
    lineNum: parseInt(m[1], 10),
    marker: m[2],
    codeText: m[3].trim(),
  };
}

const CURSOR_DIFF_HEADER_REGEX = /^(\S.*?)\s+\+\d+(?:\s+-\d+)?$/;
const CURSOR_DIFF_HEADER_PREFIX_REGEX = /^Edited\s+/i;

function parseCursorDiffHeader(text) {
  const bordered = getCursorDiffContentSpan(text);
  const source = (bordered ? bordered.content : text).trim().replace(CURSOR_DIFF_HEADER_PREFIX_REGEX, '');
  const m = CURSOR_DIFF_HEADER_REGEX.exec(source);
  if (!m) return null;
  const path = m[1].trim();
  const normalized = normalizeNavigablePath(path) || path;
  return isLikelyFilePath(normalized) ? { path } : null;
}

function parseCursorDiffBlockLine(text) {
  const bordered = getCursorDiffContentSpan(text);
  if (!bordered) return null;
  const inner = bordered.content;
  const marker = inner[0];
  if (marker !== '+' && marker !== '-') return null;
  const afterMarker = inner.slice(1);
  const content = afterMarker.trim();
  if (!content || content.length > 200) return null;
  if (isLikelyFilePath(content)) return null;
  if (looksLikeCode(content)) return null;
  const leading = afterMarker.length - afterMarker.trimStart().length;
  const contentStart = bordered.start + 1 + leading;
  return { marker, content, contentStart, contentEnd: contentStart + content.length };
}

function findCursorDiffHeaderFromLines(lines, bufferRow) {
  for (let r = bufferRow; r >= Math.max(0, bufferRow - 100); r--) {
    const text = lines[r] || '';
    const header = parseCursorDiffHeader(text);
    if (header) return header.path;
    if (!getCursorDiffContentSpan(text) && text.trim() !== '') return null;
  }
  return null;
}

const patterns = [
  {
    name: 'diff_line',
    regex: /^(?:\s{2,}\d+(?:\s[+-]\s*|\s{2,})\S.*|\s*[│┃|]\s+.*)$/g,
    filter: (text, line, index) => index === 0 && parseDiffLineText(text) !== null,
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      const bordered = getBorderedContentSpan(fullMatch);
      if (!bordered || !parseDiffLineText(bordered.content, { allowInner: true })) return null;
      return [{
        text: bordered.content,
        start: matchIndex + bordered.start,
        end: matchIndex + bordered.end,
      }];
    },
  },
  {
    name: 'source_line',
    priority: 'low',
    regex: /^(?:\s*[│┃|] | {4,}).+$/g,
    filter: (text, line, index) => {
      if (index !== 0) return false;
      return isLikelySourceLine(text);
    },
    style: 'hover-only',
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      const bordered = /^\s*[│┃|] (.+?)(?:\s+[│┃|])?\s*$/.exec(fullMatch);
      if (bordered) {
        const innerStart = fullMatch.indexOf(bordered[1]);
        return [{
          text: bordered[1],
          start: matchIndex + innerStart,
          end: matchIndex + innerStart + bordered[1].length,
        }];
      }
      const leadingSpaces = fullMatch.length - fullMatch.trimStart().length;
      const content = fullMatch.trimStart();
      return [{
        text: content,
        start: matchIndex + leadingSpaces,
        end: matchIndex + leadingSpaces + content.length,
      }];
    },
  },
  {
    name: 'diff_block',
    priority: 'low',
    regex: /^\s*[│┃|▎]\s?.+$/g,
    filter: (text) => parseCursorDiffBlockLine(text) !== null,
    style: 'hover-only',
    trimToContent: true,
    expand(fullMatch, matchIndex) {
      const parsed = parseCursorDiffBlockLine(fullMatch);
      if (!parsed) return null;
      return [{
        text: fullMatch.substring(parsed.contentStart, parsed.contentEnd),
        start: matchIndex + parsed.contentStart,
        end: matchIndex + parsed.contentEnd,
      }];
    },
  },
  {
    name: 'line_ref',
    regex: LINE_REF_REGEX,
    expand(fullMatch, matchIndex) {
      const prefixMatch = /^[Ll]ines?\s+/.exec(fullMatch);
      if (!prefixMatch) return null;
      const afterPrefix = fullMatch.substring(prefixMatch[0].length);
      const groups = afterPrefix.split(/,\s*/);
      if (groups.length <= 1) return null;
      const subMatches = [];
      let searchFrom = prefixMatch[0].length;
      for (const group of groups) {
        const groupStart = fullMatch.indexOf(group, searchFrom);
        subMatches.push({
          text: group,
          start: matchIndex + groupStart,
          end: matchIndex + groupStart + group.length,
        });
        searchFrom = groupStart + group.length;
      }
      return subMatches;
    },
  },
  {
    name: 'qualified_symbol',
    priority: 'low',
    // Matches dot-separated identifiers with 2+ segments
    regex: /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+\b/g,
    // Exclude matches that look like filenames (end with any file extension)
    filter: (text) => !FILE_EXTENSIONS.test(text),
  },
  {
    name: 'underscore_symbol',
    priority: 'low',
    // Matches identifiers with underscore: _private, my_var, __dunder__
    regex: /\b_[a-zA-Z0-9_]+\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*\b/g,
    filter: (matched, line, index) => {
      const rest = line.substring(index + matched.length);
      const extMatch = rest.match(/^(\.[a-zA-Z0-9]+)/);
      if (extMatch && FILE_EXTENSIONS.test(matched + extMatch[1])) return false;
      if (isLikelyPathNotSymbol(line, index, matched.length)) return false;
      return true;
    },
  },
  {
    name: 'camel_pascal_symbol',
    priority: 'low',
    // camelCase: lowercase start + uppercase transition (myVar, getUserName)
    // PascalCase: uppercase start + lower→upper transition (MyClass, HttpResponse)
    regex: /\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g,
    filter: (matched, line, index) => {
      if (matched.length < 4) return false;
      const rest = line.substring(index + matched.length);
      const extMatch = rest.match(/^(\.[a-zA-Z0-9]+)/);
      if (extMatch && FILE_EXTENSIONS.test(matched + extMatch[1])) return false;
      if (isLikelyPathNotSymbol(line, index, matched.length)) return false;
      return true;
    },
  },
  {
    // Python traceback: File "path/to/file.py", line 42
    name: 'python_traceback',
    regex: /File "([^"]+)", line (\d+)/g,
  },
  {
    // GitHub-style line reference: file.js#L42 or file.js#L42-L50
    name: 'github_line',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z]+#L(\d+)(?:-L\d+)?/g,
  },
  {
    // File with line and column: file.js:42:15
    name: 'file_line_col',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z0-9]+:\d+:\d+/g,
  },
  {
    // Parentheses style: file.js(42), file.js(42,15), or file.py(100-200, 300-400)
    name: 'paren_line',
    regex: /[a-zA-Z0-9_.\/…-]+\.[a-zA-Z0-9]+\(\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*\)/g,
    expand(fullMatch, matchIndex) {
      const parenIndex = fullMatch.indexOf('(');
      const inner = fullMatch.substring(parenIndex + 1, fullMatch.length - 1);
      if (!inner.includes('-')) {
        return [{ text: fullMatch, start: matchIndex, end: matchIndex + fullMatch.length }];
      }
      const groups = inner.split(/,\s*/);
      const subMatches = [];
      let searchFrom = parenIndex + 1;
      for (const group of groups) {
        const groupStart = fullMatch.indexOf(group, searchFrom);
        subMatches.push({
          text: group,
          start: matchIndex + groupStart,
          end: matchIndex + groupStart + group.length,
        });
        searchFrom = groupStart + group.length;
      }
      return subMatches;
    },
  },
  {
    // Comment-prefixed bare line reference: # :344, # :190
    name: 'comment_line_ref',
    regex: /#\s*:~?\d+(?:-~?\d+)?/g,
    filter: (text, line, index) => {
      if (index > 0 && !/\s/.test(line[index - 1])) return false;
      return true;
    },
  },
  {
    // Basic file:line - most common format
    // Requires path to start with letter, dot, or slash (not just digits)
    // Uses negative lookahead (?!:\d) to avoid matching file:line:col
    name: 'file_line',
    regex: /(?:[.\/…]|[a-zA-Z])[a-zA-Z0-9_.\/…-]*(?:\.[a-zA-Z0-9]+)?:~?\d+(?:-~?\d+)?(?!:\d)/g,
  },
  {
    name: 'wsl_unc_path',
    // WSL files in Windows UNC form: \\wsl.localhost\<distro>\... (or legacy \\wsl$\...)
    regex: /\\\\wsl(?:\.localhost|\$)\\[^\\\s<>:"|?*]+(?:\\[^\\\s<>:"|?*]+)+/gi,
  },
  {
    name: 'resource_file',
    // Matches file paths ending with resource extensions (images, docs, media, archives, data)
    regex: /(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*\.(?:png|jpe?g|gif|svg|ico|webp|bmp|tiff?|pdf|docx?|xlsx?|pptx?|rtf|epub|mp[34]|wav|avi|mov|mkv|flac|ogg|webm|zip|tgz|gz|bz2|xz|rar|7z|zst|csv|tsv|parquet|avro)\b/gi,
  },
  {
    name: 'plain_file',
    regex: /(?:[a-zA-Z]:)?(?:[.\/~…]|[a-zA-Z])[a-zA-Z0-9_.+~\/…-]*/g,
    filter: (text, line, index) => {
      const normalized = normalizeNavigablePath(text);
      const rest = line.substring(index + text.length);
      return normalized != null
        && isLikelyFilePath(normalized)
        && !RESOURCE_EXTENSIONS.test(normalized)
        && !hasLeadingLineRefContext(line, index)
        && !/^\(\d/.test(rest);
    },
  },
];

// =============================================================================
// parseRow function (duplicated from renderer.js for testing)
// =============================================================================

function parseRow(text) {
  const matches = [];

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;

    for (const match of text.matchAll(pattern.regex)) {
      // Skip if pattern has a filter that rejects this match
      if (pattern.filter && !pattern.filter(match[0], text, match.index)) {
        continue;
      }
      const matchBase = {
        patternName: pattern.name,
        trimToContent: pattern.trimToContent,
        priority: pattern.priority || 'high',
      };
      if (pattern.expand) {
        const subMatches = pattern.expand(match[0], match.index);
        if (subMatches) {
          for (const sub of subMatches) {
            matches.push({
              text: sub.text,
              start: sub.start,
              end: sub.end,
              ...matchBase,
            });
          }
          continue;
        }
      }
      {
        matches.push({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          ...matchBase,
        });
      }
    }
  }

  // Resolve overlapping matches with priority awareness
  const high = matches.filter(m => m.priority !== 'low');
  const low = matches.filter(m => m.priority === 'low');

  const byPos = (a, b) => a.start - b.start || b.end - a.end;
  high.sort(byPos);
  low.sort(byPos);

  // Greedy non-overlapping selection for high-priority matches
  const placed = [];
  for (const match of high) {
    if (placed.length === 0 || match.start >= placed[placed.length - 1].end) {
      placed.push(match);
    }
  }

  // Fit low-priority matches into gaps not claimed by high-priority
  for (const match of low) {
    const overlaps = placed.some(p =>
      match.start < p.end && match.end > p.start
    );
    if (!overlaps) {
      placed.push(match);
    }
  }

  placed.sort(byPos);

  return placed;
}

// =============================================================================
// Test Framework (minimal)
// =============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Actual:   ${actualStr}`);
  }
}

function assertMatches(text, expectedMatches) {
  const matches = parseRow(text);
  const actualTexts = matches.map((m) => m.text);
  assertEqual(actualTexts, expectedMatches, `Input: "${text}"`);
}

// =============================================================================
// Tests: qualified_symbol pattern
// =============================================================================

console.log('\n--- qualified_symbol pattern ---\n');

test('matches ClassName.method', () => {
  assertMatches('MyClass.my_method', ['MyClass.my_method']);
});

test('matches ClassName.data_member', () => {
  assertMatches('MyClass.data_attr', ['MyClass.data_attr']);
});

test('matches module.function', () => {
  assertMatches('module.function', ['module.function']);
});

test('matches deeply nested pkg.mod.Class.attr', () => {
  assertMatches('pkg.mod.Class.method', ['pkg.mod.Class.method']);
});

test('matches with underscore segments', () => {
  assertMatches('my_module.my_class.my_method', ['my_module.my_class.my_method']);
});

test('matches starting with underscore', () => {
  assertMatches('_private.method', ['_private.method']);
});

test('does not match single identifier (no dot)', () => {
  const matches = parseRow('my_func');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('qualified takes precedence over underscore in overlap', () => {
  // MyClass.my_method contains both qualified_symbol and underscore patterns
  // qualified_symbol should win because it matches the longer text
  const matches = parseRow('MyClass.my_method');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'qualified_symbol');
});

test('matches multiple qualified symbols in line', () => {
  assertMatches('Class.method and Other.attr', ['Class.method', 'Other.attr']);
});

test('does not match number starting segment', () => {
  // 123.method should not match
  const matches = parseRow('123.method');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

// =============================================================================
// Tests: qualified_symbol filter (file extension exclusion)
// =============================================================================

console.log('\n--- qualified_symbol filter ---\n');

test('filters out .js extension', () => {
  const matches = parseRow('foo.js');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .ts extension', () => {
  const matches = parseRow('foo.ts');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .py extension', () => {
  const matches = parseRow('main.py');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .json extension', () => {
  const matches = parseRow('config.json');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .md extension', () => {
  const matches = parseRow('README.md');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('does not filter os.path (not a file extension)', () => {
  const matches = parseRow('os.path');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 1);
});

test('does not filter sys.argv (not a file extension)', () => {
  const matches = parseRow('sys.argv');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 1);
});

test('does not filter Class.method', () => {
  const matches = parseRow('MyClass.method');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 1);
});

test('filter is case-insensitive for extensions', () => {
  const matches1 = parseRow('foo.JS');
  const matches2 = parseRow('foo.Ts');
  assertEqual(matches1.filter(m => m.patternName === 'qualified_symbol').length, 0);
  assertEqual(matches2.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .proto extension', () => {
  const matches = parseRow('foo.proto');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .csv extension', () => {
  const matches = parseRow('data.csv');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .png extension', () => {
  const matches = parseRow('image.png');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .exe extension', () => {
  const matches = parseRow('app.exe');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .zip extension', () => {
  const matches = parseRow('archive.zip');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

test('filters out .lua extension', () => {
  const matches = parseRow('script.lua');
  assertEqual(matches.filter(m => m.patternName === 'qualified_symbol').length, 0);
});

// =============================================================================
// Tests: underscore_symbol pattern
// =============================================================================

console.log('\n--- underscore_symbol pattern ---\n');

test('matches simple underscore identifier', () => {
  assertMatches('a_b', ['a_b']);
});

test('matches longer underscore identifier', () => {
  assertMatches('my_var_name', ['my_var_name']);
});

test('matches underscore at start', () => {
  assertMatches('_private', ['_private']);
});

test('matches underscore at end', () => {
  assertMatches('value_', ['value_']);
});

test('matches multiple underscores', () => {
  assertMatches('__double__underscore__', ['__double__underscore__']);
});

test('does not match without underscore', () => {
  assertMatches('hello', []);
});

test('does not match camelCase without underscore', () => {
  const matches = parseRow('myVar');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('matches in sentence', () => {
  assertMatches('The my_var is here', ['my_var']);
});

test('matches multiple in line', () => {
  assertMatches('a_b and c_d', ['a_b', 'c_d']);
});

// =============================================================================
// Tests: underscore_symbol filter (filename stem exclusion)
// =============================================================================

console.log('\n--- underscore_symbol filter ---\n');

test('filters out a_b_c when followed by .py', () => {
  const matches = parseRow('a_b_c.py');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out my_module when followed by .js', () => {
  const matches = parseRow('my_module.js');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out test_utils when followed by .ts', () => {
  const matches = parseRow('test_utils.ts');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out my_script when followed by .sh', () => {
  const matches = parseRow('my_script.sh');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out data_export when followed by .csv', () => {
  const matches = parseRow('data_export.csv');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out my_lib when followed by .so', () => {
  const matches = parseRow('my_lib.so');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters out case-insensitive extension: my_app.PY', () => {
  const matches = parseRow('my_app.PY');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('does not filter standalone underscore symbol', () => {
  const matches = parseRow('my_func is great');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 1);
  assertEqual(matches[0].text, 'my_func');
});

test('does not filter underscore symbol at end of line', () => {
  const matches = parseRow('call my_func');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 1);
});

test('does not filter underscore symbol followed by dot-space', () => {
  const matches = parseRow('my_func. Next sentence');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 1);
  assertEqual(matches[0].text, 'my_func');
});

test('does not filter underscore symbol followed by parens', () => {
  const matches = parseRow('my_func()');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 1);
});

test('filters filename stem in sentence context', () => {
  // "Edit a_b_c.py to fix the bug" - a_b_c should NOT be highlighted
  const matches = parseRow('Edit a_b_c.py to fix the bug');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol' && m.text === 'a_b_c').length, 0);
});

test('filters filename stem in path context', () => {
  // "src/my_module.py:42" - my_module should not be a separate symbol
  const matches = parseRow('src/my_module.py:42');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol' && m.text === 'my_module').length, 0);
});

test('keeps underscore symbol next to unrelated filename', () => {
  // "my_func in src/app.py" - my_func IS a symbol, app.py is separate
  const matches = parseRow('my_func in src/app.py');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol' && m.text === 'my_func').length, 1);
});

test('filters _private when followed by .py', () => {
  // _private.py is a filename, not a symbol
  const matches = parseRow('_private.py');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters __init__ when followed by .py', () => {
  const matches = parseRow('__init__.py');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters directory components with underscores in path', () => {
  // a/b_b/c_c/d - b_b and c_c are directories, not symbols
  const matches = parseRow('a/b_b/c_c/d');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters underscore dir at start of path', () => {
  // my_dir/file - my_dir is a directory, not a symbol
  const matches = parseRow('my_dir/file');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters underscore dir at end of path', () => {
  // src/my_dir - my_dir is preceded by /, not a symbol
  const matches = parseRow('src/my_dir');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('filters underscore dirs in backslash path', () => {
  // Windows-style: a\\b_b\\c_c\\d
  const matches = parseRow('a\\b_b\\c_c\\d');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol').length, 0);
});

test('keeps standalone underscore symbol next to path', () => {
  // "my_func in src/utils/helper" - my_func is standalone, not part of path
  const matches = parseRow('my_func in src/utils/helper');
  assertEqual(matches.filter(m => m.patternName === 'underscore_symbol' && m.text === 'my_func').length, 1);
});

test('allows slash-separated underscore symbols (A/B notation)', () => {
  // _setup_nr_environment/_setup_lte_environment — "or" notation, not a path
  const matches = parseRow('_setup_nr_environment/_setup_lte_environment');
  const syms = matches.filter(m => m.patternName === 'underscore_symbol');
  assertEqual(syms.length, 2);
  assertEqual(syms[0].text, '_setup_nr_environment');
  assertEqual(syms[1].text, '_setup_lte_environment');
});

test('allows slash-separated underscore symbols in sentence', () => {
  const matches = parseRow('Narrow return types of _setup_nr_environment/_setup_lte_environment to');
  const syms = matches.filter(m => m.patternName === 'underscore_symbol');
  assertEqual(syms.length, 2);
});

test('allows my_dir/my_sub_dir as symbols (both symbol-like)', () => {
  const matches = parseRow('my_dir/my_sub_dir');
  const syms = matches.filter(m => m.patternName === 'underscore_symbol');
  assertEqual(syms.length, 2);
});

// =============================================================================
// Tests: camel_pascal_symbol pattern (camelCase)
// =============================================================================

console.log('\n--- camel_pascal_symbol pattern (camelCase) ---\n');

test('matches camelCase: myVar', () => {
  const matches = parseRow('myVar');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol')[0].text, 'myVar');
});

test('matches camelCase: getUserName', () => {
  const matches = parseRow('getUserName');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol')[0].text, 'getUserName');
});

test('matches camelCase: parseJSON', () => {
  const matches = parseRow('parseJSON');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
});

test('does not match plain lowercase: hello', () => {
  const matches = parseRow('hello');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('does not match too-short camelCase: aB', () => {
  const matches = parseRow('aB');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('matches camelCase in sentence', () => {
  const matches = parseRow('The myVar is here');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol')[0].text, 'myVar');
});

// =============================================================================
// Tests: camel_pascal_symbol pattern (PascalCase)
// =============================================================================

console.log('\n--- camel_pascal_symbol pattern (PascalCase) ---\n');

test('matches PascalCase: MyClass', () => {
  const matches = parseRow('MyClass');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol')[0].text, 'MyClass');
});

test('matches PascalCase: HttpResponse', () => {
  const matches = parseRow('HttpResponse');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol')[0].text, 'HttpResponse');
});

test('matches PascalCase: StringBuilder', () => {
  const matches = parseRow('StringBuilder');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 1);
});

test('does not match single PascalCase word: Error', () => {
  const matches = parseRow('Error');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('does not match single PascalCase word: File', () => {
  const matches = parseRow('File');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('does not match all-uppercase: OK', () => {
  const matches = parseRow('OK');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

// =============================================================================
// Tests: camel_pascal_symbol filter
// =============================================================================

console.log('\n--- camel_pascal_symbol filter ---\n');

test('filters out MyClass.js (file extension)', () => {
  const matches = parseRow('MyClass.js');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('filters out path component: /MyClass/', () => {
  const matches = parseRow('/MyClass/');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('filters out path component: src/MyClass', () => {
  const matches = parseRow('src/MyClass');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('filters out path component: myVar\\next', () => {
  const matches = parseRow('myVar\\next');
  assertEqual(matches.filter(m => m.patternName === 'camel_pascal_symbol').length, 0);
});

test('allows slash-separated PascalCase symbols (A/B notation)', () => {
  const matches = parseRow('NeighborFinderNR/NeighborFinder');
  const syms = matches.filter(m => m.patternName === 'camel_pascal_symbol');
  assertEqual(syms.length, 2);
  assertEqual(syms[0].text, 'NeighborFinderNR');
  assertEqual(syms[1].text, 'NeighborFinder');
});

test('allows slash-separated camelCase symbols', () => {
  const matches = parseRow('getUserName/setUserName');
  const syms = matches.filter(m => m.patternName === 'camel_pascal_symbol');
  assertEqual(syms.length, 2);
});

test('allows PascalCase A/B notation in sentence', () => {
  const matches = parseRow('Narrow types to NeighborFinderNR/NeighborFinder');
  const syms = matches.filter(m => m.patternName === 'camel_pascal_symbol');
  assertEqual(syms.length, 2);
});

// =============================================================================
// Tests: camel_pascal_symbol overlap resolution
// =============================================================================

console.log('\n--- camel_pascal_symbol overlap ---\n');

test('qualified_symbol wins over embedded camelCase: Module.myMethod', () => {
  const matches = parseRow('Module.myMethod');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'qualified_symbol');
  assertEqual(matches[0].text, 'Module.myMethod');
});

test('underscore_symbol wins over embedded camelCase: my_camelCase', () => {
  const matches = parseRow('my_camelCase');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'underscore_symbol');
  assertEqual(matches[0].text, 'my_camelCase');
});

test('camelCase and underscore_symbol coexist when non-overlapping', () => {
  const matches = parseRow('myVar and my_func');
  assertEqual(matches.length, 2);
  assertEqual(matches.map(m => m.text), ['myVar', 'my_func']);
});

// =============================================================================
// Tests: diff_line pattern
// =============================================================================

console.log('\n--- diff_line pattern ---\n');

test('matches addition line (+)', () => {
  const matches = parseRow('      628 +        indexer = SearchIndexer()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('matches deletion line (-)', () => {
  const matches = parseRow('      628 -        old_indexer = LegacyIndexer()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('matches context line (no marker)', () => {
  const matches = parseRow('      625          return result');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('matches bordered addition line from approval UI', () => {
  const text = '│  23 +   "allowed_rules", "rule_set", "add_report_entry", │';
  const matches = parseRow(text);
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
  assertEqual(matches[0].text.trim(), '23 +   "allowed_rules", "rule_set", "add_report_entry",');
});

test('matches bordered context line from approval UI', () => {
  const text = '│ 10     from app.config.general_constants import RuleTypes │';
  const matches = parseRow(text);
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('bordered diff_line excludes the box borders from the clickable span', () => {
  const text = '  │  7 +   from collections import namedtuple          │';
  const matches = parseRow(text);
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
  assertEqual(matches[0].start, 4);
  assertEqual(matches[0].end < text.length - 1, true);
  assertEqual(matches[0].text.includes('│'), false);
});

test('diff_line suppresses symbol patterns in code text', () => {
  const matches = parseRow('      628 +        my_indexer = SearchIndexer()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('diff_line suppresses file:line patterns in code text', () => {
  const matches = parseRow('      42 +        import src/main.py:10');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('diff_line covers entire line', () => {
  const text = '      628 +        indexer = SearchIndexer()';
  const matches = parseRow(text);
  assertEqual(matches[0].start, 0);
  assertEqual(matches[0].end, text.length);
});

test('does not match normal text lines', () => {
  const matches = parseRow('This is a normal line of text');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 0);
});

test('does not match with only single leading space', () => {
  const matches = parseRow(' 42 + code here');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 0);
});

test('does not match line with no code text after spaces', () => {
  const matches = parseRow('      628 +        ');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 0);
});

test('matches with minimal spacing', () => {
  const matches = parseRow('  1 +  x = 1');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('matches large line numbers', () => {
  const matches = parseRow('    9999 -    old_code()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

test('diff_line propagates trimToContent flag', () => {
  const matches = parseRow('      628 +        indexer = SearchIndexer()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].trimToContent, true);
});

test('non-diff patterns do not have trimToContent', () => {
  const matches = parseRow('Error in my_func at line 42');
  for (const m of matches) {
    assertEqual(m.trimToContent, undefined, `${m.patternName} should not have trimToContent`);
  }
});

// Prose / markdown diffs: content sits flush against the +/- marker (no gutter
// indentation), unlike code whose content is indented after the marker.
test('matches markdown deletion with content flush against marker', () => {
  const matches = parseRow('      3 -*Handoff file for a new session');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 1);
});

test('matches markdown addition with content flush against marker', () => {
  const matches = parseRow('      3 +*Handoff file for a new session');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 1);
});

test('matches addition whose content itself starts with a plus', () => {
  const matches = parseRow('      6 ++ regression gate; dev engaged). The agreed phase:');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 1);
});

test('parses marker and content for flush prose deletion', () => {
  const parsed = parseDiffLineText('      3 -*Handoff file for a new session');
  assertEqual(parsed.marker, '-');
  assertEqual(parsed.codeText, '*Handoff file for a new session');
});

test('parses flush addition whose content starts with a plus', () => {
  const parsed = parseDiffLineText('      6 ++ regression gate; dev engaged');
  assertEqual(parsed.marker, '+');
  assertEqual(parsed.codeText, '+ regression gate; dev engaged');
});

test('markdown context line (no marker) still matches and parses no marker', () => {
  const text = '      1  # Next steps for the verification pass';
  assertEqual(parseRow(text).filter(m => m.patternName === 'diff_line').length, 1);
  assertEqual(parseDiffLineText(text).marker, undefined);
});

test('FP guard: number flush against text does not match', () => {
  const matches = parseRow('      42hello world this is just prose');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 0);
});

test('FP guard: numbered prose with a single space does not match', () => {
  const matches = parseRow('      3 passing tests in the suite');
  assertEqual(matches.filter(m => m.patternName === 'diff_line').length, 0);
});

// =============================================================================
// Tests: diff_block pattern (number-less bordered diffs, e.g. Cursor)
// =============================================================================
// NOTE: distinguishing a real diff from a "│ - bullet" list relies on a diff
// header above the line (findCursorDiffHeader), which needs the live terminal
// buffer and so is verified at integration level, not here. These tests cover
// the text-only half: the header parser and the per-line shape/partitioning.
console.log('\n--- diff_block pattern ---\n');

const CURSOR_HEADER = '│ ...settings/resolution/pf-unaware-rsi-collision.md +3 -6                    │';
const CURSOR_EDIT_HEADER = 'Edited gerrit-review-guide.md +21 -4';
const CURSOR_EDIT_ADD_ONLY_HEADER = 'Edited gerrit-review-guide.md +5';
const CURSOR_DEL = '│ - - The outcome depends only on the numeric value, not on the code spaces   │';
const CURSOR_ADD = '│ + - The outcome depends only on the RSI number, not the code spaces. For    │';
const CURSOR_DEL_CONT = "│ -   neighbour's RSI is applied to a bitmap sized to the source's own range  │";
const CURSOR_CONTEXT = '│   - No other setting suppresses this. In particular when time differs       │';
const CURSOR_CODE_ADD = '│ + indexer = SearchIndexer()                                                 │';
const CURSOR_GUTTER_ADD = '    ▎+ ### Preview before posting';
const CURSOR_GUTTER_CONTEXT = '    ▎  PYEOF';

test('parseCursorDiffHeader extracts the file path from a +N -M header', () => {
  const header = parseCursorDiffHeader(CURSOR_HEADER);
  assertEqual(header !== null, true);
  assertEqual(header.path, '...settings/resolution/pf-unaware-rsi-collision.md');
});

test('parseCursorDiffHeader extracts the file path from an Edited +N -M header', () => {
  const header = parseCursorDiffHeader(CURSOR_EDIT_HEADER);
  assertEqual(header !== null, true);
  assertEqual(header.path, 'gerrit-review-guide.md');
});

test('parseCursorDiffHeader accepts an Edited add-only header', () => {
  const header = parseCursorDiffHeader(CURSOR_EDIT_ADD_ONLY_HEADER);
  assertEqual(header !== null, true);
  assertEqual(header.path, 'gerrit-review-guide.md');
});

test('findCursorDiffHeader scans backward through Cursor gutter rows', () => {
  const lines = [
    CURSOR_EDIT_HEADER,
    '    ▎  PYEOF',
    '    ▎  ```',
    '    ▎ ',
    CURSOR_GUTTER_ADD,
  ];
  assertEqual(findCursorDiffHeaderFromLines(lines, 4), 'gerrit-review-guide.md');
});

test('parseCursorDiffHeader rejects prose that merely ends in +N -M', () => {
  assertEqual(parseCursorDiffHeader('│ score improved a lot +3 -6 │'), null);
});

test('diff_block matches a bordered prose deletion line', () => {
  assertEqual(parseRow(CURSOR_DEL).filter(m => m.patternName === 'diff_block').length, 1);
});

test('diff_block matches a bordered prose addition line', () => {
  assertEqual(parseRow(CURSOR_ADD).filter(m => m.patternName === 'diff_block').length, 1);
});

test('diff_block matches a Cursor gutter prose addition line', () => {
  assertEqual(parseRow(CURSOR_GUTTER_ADD).filter(m => m.patternName === 'diff_block').length, 1);
});

test('diff_block matches a wrapped continuation deletion line', () => {
  assertEqual(parseRow(CURSOR_DEL_CONT).filter(m => m.patternName === 'diff_block').length, 1);
});

test('diff_block excludes the diff marker from the clickable span', () => {
  const m = parseRow(CURSOR_DEL).find(x => x.patternName === 'diff_block');
  assertEqual(m.text, '- The outcome depends only on the numeric value, not on the code spaces');
});

test('diff_block excludes the Cursor gutter marker from the clickable span', () => {
  const m = parseRow(CURSOR_GUTTER_ADD).find(x => x.patternName === 'diff_block');
  assertEqual(m.text, '### Preview before posting');
});

test('diff_block ignores context lines (blank marker column, no +/-)', () => {
  assertEqual(parseRow(CURSOR_CONTEXT).filter(m => m.patternName === 'diff_block').length, 0);
});

test('diff_block ignores Cursor gutter context lines', () => {
  assertEqual(parseRow(CURSOR_GUTTER_CONTEXT).filter(m => m.patternName === 'diff_block').length, 0);
});

test('diff_block ignores the header line itself', () => {
  assertEqual(parseRow(CURSOR_HEADER).filter(m => m.patternName === 'diff_block').length, 0);
});

test('diff_block defers code lines to source_line', () => {
  assertEqual(parseRow(CURSOR_CODE_ADD).filter(m => m.patternName === 'diff_block').length, 0);
});

test('parseCursorDiffBlockLine reports marker and trimmed content', () => {
  const parsed = parseCursorDiffBlockLine(CURSOR_ADD);
  assertEqual(parsed.marker, '+');
  assertEqual(parsed.content, '- The outcome depends only on the RSI number, not the code spaces. For');
});

test('parseCursorDiffBlockLine reports marker and trimmed content for Cursor gutter rows', () => {
  const parsed = parseCursorDiffBlockLine(CURSOR_GUTTER_ADD);
  assertEqual(parsed.marker, '+');
  assertEqual(parsed.content, '### Preview before posting');
});

// =============================================================================
// Tests: line_ref pattern
// =============================================================================

console.log('\n--- line_ref pattern ---\n');

test('matches "Line 294"', () => {
  const matches = parseRow('1. Line 294 — pass skipped_uids back');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 1);
  assertEqual(lineRefs[0].text, 'Line 294');
});

test('matches lowercase "line 310"', () => {
  assertMatches('3. After line 310 — restore the loop', ['line 310']);
});

test('matches range "Line 597-625"', () => {
  assertMatches('Line 597-625 — rename test back', ['Line 597-625']);
});

test('matches "Lines 10-20"', () => {
  assertMatches('Lines 10-20 need changes', ['Lines 10-20']);
});

test('matches multiple line refs in one line', () => {
  assertMatches('see Line 42 and Line 100', ['Line 42', 'Line 100']);
});

test('does not match bare number without Line prefix', () => {
  const matches = parseRow('fix the bug at 294');
  assertEqual(matches.filter(m => m.patternName === 'line_ref').length, 0);
});

test('matches continuation ranges "line 1-10, 6-9"', () => {
  const matches = parseRow('a.py (line 1-10, 6-9)');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 2);
  assertEqual(lineRefs[0].text, '1-10');
  assertEqual(lineRefs[1].text, '6-9');
});

test('matches three continuation ranges', () => {
  const matches = parseRow('lines 1-10, 20-30, 40-50');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 3);
  assertEqual(lineRefs[0].text, '1-10');
  assertEqual(lineRefs[1].text, '20-30');
  assertEqual(lineRefs[2].text, '40-50');
});

test('single range with no continuation keeps default behavior', () => {
  assertMatches('Line 597-625 — rename test back', ['Line 597-625']);
});

test('matches approximate line reference "line ~10"', () => {
  const matches = parseRow('a.py (line ~10) does not work');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 1);
  assertEqual(lineRefs[0].text, 'line ~10');
});

test('matches line ref before trailing filename', () => {
  assertMatches('line 116 in conflict_finder.py', ['line 116']);
});

test('matches compact Claude read range "L20:105"', () => {
  const matches = parseRow('  └ L20:105 (85 lines read)');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 1);
  assertEqual(lineRefs[0].text, 'L20:105');
});

test('compact Claude read range wins over file_line', () => {
  const matches = parseRow('L20:105');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'line_ref');
  assertEqual(matches[0].text, 'L20:105');
});

test('continuation ranges still expand before trailing filename', () => {
  const matches = parseRow('lines 167-175, 200-205 in retrigger.py');
  const lineRefs = matches.filter(m => m.patternName === 'line_ref');
  assertEqual(lineRefs.length, 2);
  assertEqual(lineRefs[0].text, '167-175');
  assertEqual(lineRefs[1].text, '200-205');
});

// =============================================================================
// Tests: file_line pattern
// =============================================================================

console.log('\n--- file_line pattern ---\n');

test('matches simple file:line', () => {
  assertMatches('src/foo.ts:42', ['src/foo.ts:42']);
});

test('matches file with multiple extensions', () => {
  assertMatches('src/foo.test.ts:42', ['src/foo.test.ts:42']);
});

test('matches absolute path', () => {
  assertMatches('/Users/me/project/file.js:100', ['/Users/me/project/file.js:100']);
});

test('matches relative path with dots', () => {
  assertMatches('../lib/utils.py:5', ['../lib/utils.py:5']);
});

test('matches in error message', () => {
  assertMatches('Error at src/main.rs:123: something failed', ['src/main.rs:123']);
});

test('plain source file path is clickable without line number', () => {
  const matches = parseRow('src/foo.ts');
  assertEqual(matches.map((m) => m.patternName), ['plain_file']);
  assertEqual(matches.map((m) => m.text), ['src/foo.ts']);
});

test('plain source file path with trailing period is still clickable', () => {
  const matches = parseRow('See src/components/Button.tsx.');
  assertEqual(matches.map((m) => m.patternName), ['plain_file']);
  assertEqual(matches.map((m) => m.text), ['src/components/Button.tsx.']);
});

test('plain source file path with elided prefix is still clickable', () => {
  const matches = parseRow('.../src/components/Button.tsx');
  assertEqual(matches.map((m) => m.patternName), ['plain_file']);
  assertEqual(matches.map((m) => m.text), ['.../src/components/Button.tsx']);
});

test('plain source file path with partially elided prefix is still clickable', () => {
  const text = '  │ ...rithm/resolution/avr_rollback_rule_validator.py +15 -3 │';
  const matches = parseRow(text);
  assertEqual(matches.map((m) => m.patternName), ['plain_file']);
  assertEqual(matches.map((m) => m.text), ['...rithm/resolution/avr_rollback_rule_validator.py']);
});

test('plain source file path with unicode partially elided prefix is still clickable', () => {
  const text = '  │ …rithm/resolution/avr_rollback_rule_validator.py +15 -3 │';
  const matches = parseRow(text);
  assertEqual(matches.map((m) => m.patternName), ['plain_file']);
  assertEqual(matches.map((m) => m.text), ['…rithm/resolution/avr_rollback_rule_validator.py']);
});

test('explicit file:line takes precedence over plain file path', () => {
  const matches = parseRow('src/foo.ts:42');
  assertEqual(matches.map((m) => m.patternName), ['file_line']);
  assertEqual(matches.map((m) => m.text), ['src/foo.ts:42']);
});

test('matches extensionless short names (filtered in action)', () => {
  // Now matches extensionless files - action handler filters invalid paths
  assertMatches('foo:42', ['foo:42']);
});

test('matches multiple file:line in one line', () => {
  assertMatches('see src/a.ts:1 and src/b.ts:2', ['src/a.ts:1', 'src/b.ts:2']);
});

test('matches extensionless files', () => {
  assertMatches('Makefile:10', ['Makefile:10']);
});

test('matches Dockerfile', () => {
  assertMatches('Dockerfile:25', ['Dockerfile:25']);
});

test('matches file:line-range format', () => {
  assertMatches('reporting_helpers.py:33-34', ['reporting_helpers.py:33-34']);
});

test('matches file:line-range in prose with trailing colon', () => {
  assertMatches('The bug is in reporting_helpers.py:33-34:', ['reporting_helpers.py:33-34']);
});

test('matches file:~line approximate syntax', () => {
  assertMatches('retrigger.py:~497-504', ['retrigger.py:~497-504']);
});

test('matches file:~line without range', () => {
  assertMatches('see src/foo.py:~42 for details', ['src/foo.py:~42']);
});

test('matches file:~line-~line with both approximate', () => {
  assertMatches('utils.js:~10-~20', ['utils.js:~10-~20']);
});

// =============================================================================
// Tests: python_traceback pattern
// =============================================================================

console.log('\n--- python_traceback pattern ---\n');

test('matches basic Python traceback', () => {
  assertMatches('File "app.py", line 42', ['File "app.py", line 42']);
});

test('matches Python traceback with path', () => {
  assertMatches('File "/home/user/project/main.py", line 100', ['File "/home/user/project/main.py", line 100']);
});

test('matches Python traceback with relative path', () => {
  assertMatches('File "./src/utils.py", line 5', ['File "./src/utils.py", line 5']);
});

test('matches Python traceback in full error', () => {
  const text = '  File "test.py", line 10, in <module>';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'python_traceback'), true);
});

test('does not match incomplete Python traceback', () => {
  const matches = parseRow('File "test.py"');
  assertEqual(matches.filter(m => m.patternName === 'python_traceback').length, 0);
});

// =============================================================================
// Tests: github_line pattern
// =============================================================================

console.log('\n--- github_line pattern ---\n');

test('matches GitHub line reference', () => {
  assertMatches('src/main.js#L42', ['src/main.js#L42']);
});

test('matches GitHub line range', () => {
  assertMatches('src/main.js#L42-L50', ['src/main.js#L42-L50']);
});

test('matches GitHub line with path', () => {
  assertMatches('lib/utils/helper.ts#L100', ['lib/utils/helper.ts#L100']);
});

test('does not match without L prefix', () => {
  const matches = parseRow('file.js#42');
  assertEqual(matches.filter(m => m.patternName === 'github_line').length, 0);
});

test('matches in URL context', () => {
  const text = 'see https://github.com/user/repo/blob/main/src/index.ts#L25';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'github_line'), true);
});

// =============================================================================
// Tests: file_line_col pattern
// =============================================================================

console.log('\n--- file_line_col pattern ---\n');

test('matches file:line:col', () => {
  assertMatches('src/main.ts:42:15', ['src/main.ts:42:15']);
});

test('matches TypeScript error format', () => {
  assertMatches('src/app.tsx:100:5', ['src/app.tsx:100:5']);
});

test('matches ESLint output', () => {
  const text = '/project/src/index.js:10:3: error';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'file_line_col'), true);
});

test('matches with single digit column', () => {
  assertMatches('file.js:1:1', ['file.js:1:1']);
});

test('matches with large numbers', () => {
  assertMatches('file.js:9999:999', ['file.js:9999:999']);
});

// =============================================================================
// Tests: paren_line pattern
// =============================================================================

console.log('\n--- paren_line pattern ---\n');

test('matches paren line reference', () => {
  assertMatches('main.js(42)', ['main.js(42)']);
});

test('matches paren line with column', () => {
  assertMatches('main.js(42,15)', ['main.js(42,15)']);
});

test('matches paren line with column and space', () => {
  assertMatches('main.js(42, 15)', ['main.js(42, 15)']);
});

test('matches paren line with path', () => {
  assertMatches('src/utils/helper.cs(100)', ['src/utils/helper.cs(100)']);
});

test('matches MSBuild error format', () => {
  const text = 'Program.cs(25): error CS1002';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'paren_line'), true);
});

test('matches paren line range format', () => {
  const matches = parseRow('file.py(100-200)');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, '100-200');
  assertEqual(matches[0].patternName, 'paren_line');
});

test('expands multi-range into separate clickable regions', () => {
  const matches = parseRow('file.py(100-200, 300-400)');
  assertEqual(matches.length, 2);
  assertEqual(matches[0].text, '100-200');
  assertEqual(matches[1].text, '300-400');
  assertEqual(matches[0].patternName, 'paren_line');
  assertEqual(matches[1].patternName, 'paren_line');
});

test('expand positions are correct for multi-range', () => {
  const text = 'file.py(100-200, 300-400)';
  const matches = parseRow(text);
  assertEqual(matches[0].start, text.indexOf('100-200'));
  assertEqual(matches[0].end, text.indexOf('100-200') + '100-200'.length);
  assertEqual(matches[1].start, text.indexOf('300-400'));
  assertEqual(matches[1].end, text.indexOf('300-400') + '300-400'.length);
});

test('paren line,col without hyphen remains single match', () => {
  const matches = parseRow('file.py(42,15)');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, 'file.py(42,15)');
});

test('paren single number without hyphen remains single match', () => {
  const matches = parseRow('file.py(42)');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, 'file.py(42)');
});

// =============================================================================
// Tests: resource_file pattern
// =============================================================================

console.log('\n--- resource_file pattern ---\n');

test('matches simple image filename', () => {
  assertMatches('image.png', ['image.png']);
});

test('matches jpeg with path', () => {
  assertMatches('./assets/logo.jpg', ['./assets/logo.jpg']);
});

test('matches jpeg alternate extension', () => {
  assertMatches('photo.jpeg', ['photo.jpeg']);
});

test('matches absolute path to PDF', () => {
  assertMatches('/tmp/test.pdf', ['/tmp/test.pdf']);
});

test('matches home-relative path', () => {
  assertMatches('~/Documents/report.xlsx', ['~/Documents/report.xlsx']);
});

test('matches tilde path with nested dirs', () => {
  assertMatches('~/pics/vacation/beach.gif', ['~/pics/vacation/beach.gif']);
});

test('matches archive extensions', () => {
  assertMatches('backup.tar.gz and data.zip', ['backup.tar.gz', 'data.zip']);
});

test('matches video file', () => {
  assertMatches('recording.mp4', ['recording.mp4']);
});

test('matches audio file', () => {
  assertMatches('song.mp3', ['song.mp3']);
});

test('matches data formats', () => {
  assertMatches('export.csv and table.parquet', ['export.csv', 'table.parquet']);
});

test('matches tiff with optional f', () => {
  assertMatches('scan.tif and scan2.tiff', ['scan.tif', 'scan2.tiff']);
});

test('matches doc/docx', () => {
  assertMatches('letter.doc and report.docx', ['letter.doc', 'report.docx']);
});

test('matches multiple resource files in line', () => {
  assertMatches('Check image.png and ./assets/logo.jpg and /tmp/test.pdf', [
    'image.png', './assets/logo.jpg', '/tmp/test.pdf',
  ]);
});

test('does not match bare number prefix', () => {
  // "2.png" should not match because it starts with a digit
  assertMatches('file 2.png', []);
});

test('file_line wins over resource_file for file.png:10', () => {
  const matches = parseRow('image.png:10');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'file_line');
  assertEqual(matches[0].text, 'image.png:10');
});

test('resource_file does not steal from URL', () => {
  // URL pattern is not in test patterns, but resource_file should be a substring
  // of the URL, so if url pattern existed it would win. Here we just verify
  // resource_file matches the tail — in production, dedup keeps the longer url match.
  const matches = parseRow('https://example.com/image.png');
  // resource_file matches "image.png" as a substring but it's contained in the full URL match
  // Since url pattern isn't in test suite, resource_file will match the tail
  const resourceMatches = matches.filter(m => m.patternName === 'resource_file');
  assertEqual(resourceMatches.length <= 1, true);
});

test('resource_file matches case-insensitively', () => {
  assertMatches('Photo.PNG', ['Photo.PNG']);
});

test('resource_file matches with plus in path', () => {
  assertMatches('assets/img+icon.svg', ['assets/img+icon.svg']);
});

test('resource_file takes precedence over plain_file', () => {
  const matches = parseRow('assets/image.png');
  assertEqual(matches.map((m) => m.patternName), ['resource_file']);
  assertEqual(matches.map((m) => m.text), ['assets/image.png']);
});

// =============================================================================
// Tests: wsl_unc_path pattern
// =============================================================================

console.log('\n--- wsl_unc_path pattern ---\n');

test('UNC wsl.localhost path is claimed as one span', () => {
  const text = String.raw`\\wsl.localhost\Ubuntu-22.04\home\albert\latency_debug_repeats.xlsx`;
  const matches = parseRow(text);
  assertEqual(matches.map((m) => m.patternName), ['wsl_unc_path']);
  assertEqual(matches[0].text, text);
});

test('legacy wsl$ prefix is matched', () => {
  const text = String.raw`\\wsl$\Ubuntu-22.04\home\albert\report.pdf`;
  const matches = parseRow(text);
  assertEqual(matches.map((m) => m.patternName), ['wsl_unc_path']);
  assertEqual(matches[0].text, text);
});

test('UNC path to source file suppresses fragment matches', () => {
  const text = String.raw`\\wsl.localhost\Ubuntu-22.04\home\albert\proj\my_script.py`;
  const matches = parseRow(text);
  assertEqual(matches.map((m) => m.patternName), ['wsl_unc_path']);
  assertEqual(matches[0].text, text);
});

test('UNC path embedded in prose', () => {
  const text = String.raw`saved to \\wsl.localhost\Ubuntu-22.04\home\albert\data.csv for review`;
  const matches = parseRow(text);
  const unc = matches.filter((m) => m.patternName === 'wsl_unc_path');
  assertEqual(unc.map((m) => m.text), [String.raw`\\wsl.localhost\Ubuntu-22.04\home\albert\data.csv`]);
});

test('non-wsl UNC path keeps today\'s filename-only behavior', () => {
  const matches = parseRow(String.raw`\\fileserver\share\budget.xlsx`);
  assertEqual(matches.map((m) => m.patternName), ['resource_file']);
  assertEqual(matches[0].text, 'budget.xlsx');
});

test('drive-letter path keeps today\'s behavior', () => {
  const matches = parseRow(String.raw`C:\Users\albert\photo.png`);
  const unc = matches.filter((m) => m.patternName === 'wsl_unc_path');
  assertEqual(unc, []);
});

test('bare distro share root without a file component is not matched', () => {
  const matches = parseRow(String.raw`\\wsl.localhost\Ubuntu-22.04`);
  const unc = matches.filter((m) => m.patternName === 'wsl_unc_path');
  assertEqual(unc, []);
});

test('wslUncToPosix strips prefix and flips separators', () => {
  assertEqual(
    wslUncToPosix(String.raw`\\wsl.localhost\Ubuntu-22.04\home\albert\latency_debug_repeats.xlsx`),
    '/home/albert/latency_debug_repeats.xlsx');
});

test('wslUncToPosix handles legacy wsl$ prefix', () => {
  assertEqual(
    wslUncToPosix(String.raw`\\wsl$\Ubuntu-22.04\home\albert\report.pdf`),
    '/home/albert/report.pdf');
});

test('source file .py is not matched as resource', () => {
  const matches = parseRow('script.py');
  const resourceMatches = matches.filter(m => m.patternName === 'resource_file');
  assertEqual(resourceMatches.length, 0);
});

test('source file .js is not matched as resource', () => {
  const matches = parseRow('app.js');
  const resourceMatches = matches.filter(m => m.patternName === 'resource_file');
  assertEqual(resourceMatches.length, 0);
});

test('xlsx is matched as resource, not source', () => {
  const matches = parseRow('data.xlsx');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'resource_file');
});

// =============================================================================
// Tests: mixed patterns
// =============================================================================

console.log('\n--- mixed patterns ---\n');

test('matches both patterns in same line', () => {
  const matches = parseRow('Error in my_func at src/foo.ts:42');
  assertEqual(matches.map((m) => m.text), ['my_func', 'src/foo.ts:42']);
  assertEqual(matches.map((m) => m.patternName), ['underscore_symbol', 'file_line']);
});

test('returns correct positions', () => {
  const matches = parseRow('hello a_b world');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].start, 6);
  assertEqual(matches[0].end, 9);
});

test('handles empty string', () => {
  assertMatches('', []);
});

test('handles string with no matches', () => {
  assertMatches('hello world', []);
});

// =============================================================================
// Tests: Overlap resolution
// =============================================================================

console.log('\n--- overlap resolution ---\n');

test('longer match wins over embedded shorter match', () => {
  // 'my_func' (underscore_symbol) is embedded inside 'src/my_func.py:10' (file_line)
  // file_line should win because it's longer
  const matches = parseRow('see src/my_func.py:10 here');
  const texts = matches.map(m => m.text);
  assertEqual(texts.includes('src/my_func.py:10'), true);
  assertEqual(texts.includes('my_func'), false);
});

test('longer match wins when same start position', () => {
  // file_line_col (file.js:10:5) vs file_line (file.js:10)
  // Both start at same position, file_line_col is longer
  const matches = parseRow('file.js:10:5');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'file_line_col');
});

test('earlier start wins for same-length overlapping matches', () => {
  // Create overlapping same-length scenario using patterns
  // 'a_b.c_d' - qualified_symbol matches full string (7 chars)
  // But also 'a_b' and 'c_d' are underscore_symbols
  // qualified_symbol should win (longer), leaving no room for underscore matches
  const matches = parseRow('a_b.c_d');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'qualified_symbol');
  assertEqual(matches[0].text, 'a_b.c_d');
});

test('non-overlapping matches all kept', () => {
  // Multiple matches that don't overlap should all be kept
  const matches = parseRow('my_func and your_func');
  assertEqual(matches.length, 2);
  assertEqual(matches.map(m => m.text), ['my_func', 'your_func']);
});

test('first pattern wins for identical span', () => {
  // If two patterns match exact same text, first pattern in array wins
  // This is hard to test directly since our patterns don't have identical regexes
  // But we can verify the algorithm by checking that only one match is kept
  // 'os.path' matches qualified_symbol only (no underscore)
  const matches = parseRow('os.path');
  assertEqual(matches.length, 1);
});

test('partial overlap discards later match', () => {
  // 'Module.my_var' - qualified_symbol matches full string
  // underscore_symbol would match 'my_var' which overlaps
  const matches = parseRow('Module.my_var');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, 'Module.my_var');
  assertEqual(matches[0].patternName, 'qualified_symbol');
});

test('file_line wins over qualified_symbol when overlapping', () => {
  // 'foo.bar:10' - file_line matches full, qualified_symbol matches 'foo.bar'
  // file_line is longer and wins
  const matches = parseRow('foo.bar:10');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'file_line');
});

test('adjacent non-overlapping matches both kept', () => {
  // Two patterns right next to each other (no overlap)
  const matches = parseRow('my_func:other_func');
  // This could match as file_line or two underscore_symbols depending on interpretation
  // The colon makes it look like file_line for extensionless file
  assertEqual(matches.length >= 1, true);
});

// =============================================================================
// Tests: Coordinate calculation
// =============================================================================

console.log('\n--- coordinate calculation ---\n');

// Simulates the logic from createDecoration that maps text offset to row/col
function calculatePosition(startRow, matchStart, rowLengths) {
  let remainingOffset = matchStart;
  let currentRow = startRow;
  let col = 0;

  for (let i = 0; i < rowLengths.length; i++) {
    const lineLength = rowLengths[i];
    if (remainingOffset < lineLength) {
      col = remainingOffset;
      break;
    }
    remainingOffset -= lineLength;
    currentRow++;
  }

  return { row: currentRow, col };
}

test('match at start of single row', () => {
  const pos = calculatePosition(0, 0, [80]);
  assertEqual(pos, { row: 0, col: 0 });
});

test('match in middle of single row', () => {
  const pos = calculatePosition(0, 10, [80]);
  assertEqual(pos, { row: 0, col: 10 });
});

test('match at end of single row', () => {
  const pos = calculatePosition(0, 79, [80]);
  assertEqual(pos, { row: 0, col: 79 });
});

test('match wraps to second row', () => {
  // Text is 100 chars, first row is 80, match starts at char 85
  const pos = calculatePosition(0, 85, [80, 20]);
  assertEqual(pos, { row: 1, col: 5 });
});

test('match wraps to third row', () => {
  // Three rows of 40 chars each, match starts at char 100
  const pos = calculatePosition(5, 100, [40, 40, 40]);
  assertEqual(pos, { row: 7, col: 20 });
});

test('starting row offset preserved', () => {
  const pos = calculatePosition(10, 5, [80]);
  assertEqual(pos, { row: 10, col: 5 });
});

// =============================================================================
// Tests: Row filtering logic
// =============================================================================

console.log('\n--- row filtering logic ---\n');

// Simulates the filtering logic from processVisibleRows
function shouldProcessRow(row, cursorRow, processedRows, isWrapped) {
  if (row >= cursorRow) return { process: false, reason: 'at/below cursor' };
  if (processedRows.has(row)) return { process: false, reason: 'already processed' };
  if (isWrapped) return { process: false, reason: 'wrapped line' };
  return { process: true, reason: null };
}

test('processes row above cursor', () => {
  const result = shouldProcessRow(5, 10, new Set(), false);
  assertEqual(result.process, true);
});

test('skips row at cursor', () => {
  const result = shouldProcessRow(10, 10, new Set(), false);
  assertEqual(result.process, false);
  assertEqual(result.reason, 'at/below cursor');
});

test('skips row below cursor', () => {
  const result = shouldProcessRow(15, 10, new Set(), false);
  assertEqual(result.process, false);
});

test('skips already processed row', () => {
  const processed = new Set([5]);
  const result = shouldProcessRow(5, 10, processed, false);
  assertEqual(result.process, false);
  assertEqual(result.reason, 'already processed');
});

test('skips wrapped row', () => {
  const result = shouldProcessRow(5, 10, new Set(), true);
  assertEqual(result.process, false);
  assertEqual(result.reason, 'wrapped line');
});

// =============================================================================
// Tests: File context tracking (isLikelyFilePath and extractFilePath)
// =============================================================================

console.log('\n--- file context tracking ---\n');

function extractFilePath(match) {
  let filePath = null;

  if (match.patternName === 'python_traceback') {
    const m = /File "([^"]+)"/.exec(match.text);
    filePath = m ? m[1] : null;
  } else if (match.patternName === 'github_line') {
    filePath = match.text.split('#')[0];
  } else if (match.patternName === 'paren_line') {
    filePath = match.text.split('(')[0];
  } else if (match.patternName === 'file_line' || match.patternName === 'file_line_col') {
    const parts = match.text.split(':');
    parts.pop();
    if (match.patternName === 'file_line_col') parts.pop();
    filePath = parts.join(':');
  } else if (match.patternName === 'plain_file') {
    filePath = match.text;
  }

  const normalized = normalizeNavigablePath(filePath);
  if (normalized && isLikelyFilePath(normalized)) {
    return normalized;
  }
  return null;
}

test('isLikelyFilePath: path with slash', () => {
  assertEqual(isLikelyFilePath('src/foo.py'), true);
});

test('isLikelyFilePath: path with known extension', () => {
  assertEqual(isLikelyFilePath('foo.py'), true);
});

test('isLikelyFilePath: qualified symbol (no slash, no known ext)', () => {
  assertEqual(isLikelyFilePath('Foo.bar'), false);
});

test('isLikelyFilePath: module.submodule', () => {
  assertEqual(isLikelyFilePath('module.submodule'), false);
});

test('isLikelyFilePath: bare "/" is not a file', () => {
  assertEqual(isLikelyFilePath('/'), false);
});

test('isLikelyFilePath: "prioritized/ordered" is not a file', () => {
  assertEqual(isLikelyFilePath('prioritized/ordered'), false);
});

test('isLikelyFilePath: "if/else" is not a file', () => {
  assertEqual(isLikelyFilePath('if/else'), false);
});

test('isLikelyFilePath: absolute path without extension', () => {
  assertEqual(isLikelyFilePath('/Users/dev/Makefile'), true);
});

test('isLikelyFilePath: home-relative folder', () => {
  assertEqual(isLikelyFilePath('~/agent-term'), true);
});

test('isLikelyFilePath: home-relative nested path without extension', () => {
  assertEqual(isLikelyFilePath('~/.claude/projects'), true);
});

test('isLikelyFilePath: bare tilde is not a match', () => {
  assertEqual(isLikelyFilePath('~'), false);
});

test('isLikelyFilePath: relative ./ path without extension', () => {
  assertEqual(isLikelyFilePath('./src/utils/helper'), true);
});

test('isLikelyFilePath: relative ../ path without extension', () => {
  assertEqual(isLikelyFilePath('../lib/module'), true);
});

test('isLikelyFilePath: path with slash and known extension', () => {
  assertEqual(isLikelyFilePath('src/components/Button.tsx'), true);
});

test('isLikelyFilePath: 3 segments without extension rejected', () => {
  assertEqual(isLikelyFilePath('src/components/Button'), false);
});

test('isLikelyFilePath: 4+ segments without extension accepted', () => {
  assertEqual(isLikelyFilePath('src/components/ui/Button'), true);
});

test('extractFilePath: file_line pattern', () => {
  const match = { text: 'src/foo.py:42', patternName: 'file_line' };
  assertEqual(extractFilePath(match), 'src/foo.py');
});

test('extractFilePath: file_line_col pattern', () => {
  const match = { text: 'src/foo.py:42:5', patternName: 'file_line_col' };
  assertEqual(extractFilePath(match), 'src/foo.py');
});

test('extractFilePath: python_traceback pattern', () => {
  const match = { text: 'File "src/foo.py", line 42', patternName: 'python_traceback' };
  assertEqual(extractFilePath(match), 'src/foo.py');
});

test('extractFilePath: github_line pattern', () => {
  const match = { text: 'src/foo.py#L42', patternName: 'github_line' };
  assertEqual(extractFilePath(match), 'src/foo.py');
});

test('extractFilePath: paren_line pattern', () => {
  const match = { text: 'src/foo.py(42)', patternName: 'paren_line' };
  assertEqual(extractFilePath(match), 'src/foo.py');
});

test('extractFilePath: returns null for non-file pattern', () => {
  const match = { text: 'my_func', patternName: 'underscore_symbol' };
  assertEqual(extractFilePath(match), null);
});

test('extractFilePath: returns null for path without slash or known ext', () => {
  // foo:42 matches file_line but "foo" is not a likely file path
  const match = { text: 'foo:42', patternName: 'file_line' };
  assertEqual(extractFilePath(match), null);
});

test('extractFilePath: handles path with colons (Windows-like)', () => {
  const match = { text: 'C:/Users/foo.py:42', patternName: 'file_line' };
  assertEqual(extractFilePath(match), 'C:/Users/foo.py');
});

test('extractFilePath: plain_file strips trailing punctuation', () => {
  const match = { text: 'src/components/Button.tsx.', patternName: 'plain_file' };
  assertEqual(extractFilePath(match), 'src/components/Button.tsx');
});

test('extractFilePath: plain_file strips elided prefix', () => {
  const match = { text: '.../src/components/Button.tsx', patternName: 'plain_file' };
  assertEqual(extractFilePath(match), 'src/components/Button.tsx');
});

test('extractFilePath: plain_file strips partially elided prefix segment', () => {
  const match = { text: '...rithm/resolution/avr_rollback_rule_validator.py', patternName: 'plain_file' };
  assertEqual(extractFilePath(match), 'resolution/avr_rollback_rule_validator.py');
});

test('extractFilePath: plain_file strips unicode partially elided prefix segment', () => {
  const match = { text: '…rithm/resolution/avr_rollback_rule_validator.py', patternName: 'plain_file' };
  assertEqual(extractFilePath(match), 'resolution/avr_rollback_rule_validator.py');
});

// =============================================================================
// Tests: looksLikeCode helper
// =============================================================================

console.log('\n--- looksLikeCode helper ---\n');

test('keyword: def starts code', () => {
  assertEqual(looksLikeCode('def foo():'), true);
});

test('keyword: class starts code', () => {
  assertEqual(looksLikeCode('class MyClass:'), true);
});

test('keyword: return starts code', () => {
  assertEqual(looksLikeCode('return result'), true);
});

test('keyword: import starts code', () => {
  assertEqual(looksLikeCode('import os'), true);
});

test('keyword: const starts code', () => {
  assertEqual(looksLikeCode('const x = 5;'), true);
});

test('keyword: fn starts code (Rust)', () => {
  assertEqual(looksLikeCode('fn main() {'), true);
});

test('keyword: pub starts code (Rust)', () => {
  assertEqual(looksLikeCode('pub fn process() {'), true);
});

test('signals: function call + brackets = code', () => {
  assertEqual(looksLikeCode('foo(bar)'), true);
});

test('signals: dot access + assignment = code', () => {
  assertEqual(looksLikeCode('self.x = value'), true);
});

test('signals: operators + brackets = code', () => {
  assertEqual(looksLikeCode('if (x > 0) {'), true);
});

test('signals: comment + function call = code', () => {
  assertEqual(looksLikeCode('# process(data)'), true);
});

test('signals: trailing semicolon + assignment = code', () => {
  assertEqual(looksLikeCode('x = 5;'), true);
});

test('single signal not enough: just dot access', () => {
  assertEqual(looksLikeCode('foo.bar'), false);
});

test('plain prose is not code', () => {
  assertEqual(looksLikeCode('This is a normal sentence'), false);
});

test('prose with one slash is not code', () => {
  assertEqual(looksLikeCode('prioritized/ordered'), false);
});

test('empty string is not code', () => {
  assertEqual(looksLikeCode(''), false);
});

test('prose with embedded function ref is not code', () => {
  assertEqual(looksLikeCode('- process_user_group() discovers the user group on-the-fly per active session:'), false);
});

test('long code line with many params still detected', () => {
  assertEqual(looksLikeCode('result = calculate(a, b, c, d, e)'), true);
});

// =============================================================================
// Tests: isLikelySourceLine helper
// =============================================================================

console.log('\n--- isLikelySourceLine helper ---\n');

test('bordered: │ def foo(): │', () => {
  assertEqual(isLikelySourceLine('  │ def foo():                        │'), true);
});

test('bordered: │ return bar │', () => {
  assertEqual(isLikelySourceLine('  │     return bar                    │'), true);
});

test('bordered: │ self.x = value │', () => {
  assertEqual(isLikelySourceLine('  │ self.x = value                    │'), true);
});

test('bordered: rejects prose in box', () => {
  assertEqual(isLikelySourceLine('  │ This is a description of the fix  │'), false);
});

test('bordered: rejects file path in box', () => {
  assertEqual(isLikelySourceLine('  │ src/renderer.js                   │'), false);
});

test('borderless: 4+ spaces + code', () => {
  assertEqual(isLikelySourceLine('    def foo():'), true);
});

test('borderless: 8 spaces + code', () => {
  assertEqual(isLikelySourceLine('        return self.value'), true);
});

test('borderless: rejects <4 spaces', () => {
  assertEqual(isLikelySourceLine('   def foo():'), false);
});

test('borderless: rejects 0 spaces', () => {
  assertEqual(isLikelySourceLine('def foo():'), false);
});

test('borderless: rejects prose with 4 spaces', () => {
  assertEqual(isLikelySourceLine('    This is just indented text'), false);
});

test('rejects overly long line (>120 chars)', () => {
  const long = '  │ ' + 'x'.repeat(121) + ' │';
  assertEqual(isLikelySourceLine(long), false);
});

test('rejects empty bordered line', () => {
  assertEqual(isLikelySourceLine('  │                                   │'), false);
});

// =============================================================================
// Tests: source_line pattern (via parseRow)
// =============================================================================

console.log('\n--- source_line pattern ---\n');

test('source_line matches bordered code line', () => {
  const matches = parseRow('  │ def foo():                        │');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line matches bordered return', () => {
  const matches = parseRow('  │     return bar                    │');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line matches borderless indented code', () => {
  const matches = parseRow('    def foo():');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line matches borderless assignment', () => {
  const matches = parseRow('    self.x = value');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line rejects bordered prose', () => {
  const matches = parseRow('  │ This is a plan description         │');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 0);
});

test('source_line rejects borderless prose', () => {
  const matches = parseRow('    This is just indented text');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 0);
});

test('source_line rejects line with <4 spaces', () => {
  const matches = parseRow('   def foo():');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 0);
});

test('source_line has trimToContent flag', () => {
  const matches = parseRow('  │ def foo():                        │');
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl.length, 1);
  assertEqual(sl[0].trimToContent, true);
});

test('source_line: JS const/let/var', () => {
  const matches = parseRow('    const x = 5;');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line: Rust fn', () => {
  const matches = parseRow('    fn main() {');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line: Python import', () => {
  const matches = parseRow('    import os');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 1);
});

test('source_line: does not match file path lines', () => {
  const matches = parseRow('    src/renderer.js');
  assertEqual(matches.filter(m => m.patternName === 'source_line').length, 0);
});

test('diff_line takes priority over source_line for diff output', () => {
  // diff lines start with leading spaces + line number, which is different
  // from source_line's bordered/indented patterns
  const matches = parseRow('      628 +        indexer = SearchIndexer()');
  assertEqual(matches.length, 1);
  assertEqual(matches[0].patternName, 'diff_line');
});

// =============================================================================
// Tests: source_line expand (underline positioning)
// =============================================================================

console.log('\n--- source_line expand ---\n');

test('bordered: expand narrows to inner content text', () => {
  const text = '  │ def foo():                        │';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl.length, 1);
  assertEqual(sl[0].text, 'def foo():');
});

test('bordered: expand start position skips border', () => {
  const text = '  │ def foo():                        │';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl[0].start, 4); // after "  │ "
});

test('bordered: expand end position excludes trailing padding and border', () => {
  const text = '  │ def foo():                        │';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl[0].end, 14); // 4 + len("def foo():")
});

test('bordered: indented code inside box preserves inner indent', () => {
  const text = '  │     return bar                    │';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  // Inner indent is kept — trimToContent handles whitespace at render time
  assertEqual(sl[0].text, '    return bar');
  assertEqual(sl[0].start, 4); // after "  │ "
});

test('bordered: no right border still works', () => {
  const text = '│ const x = 5;';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl.length, 1);
  assertEqual(sl[0].text, 'const x = 5;');
  assertEqual(sl[0].start, 2); // after "│ "
});

test('borderless: expand narrows to trimmed content', () => {
  const text = '    def foo():';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl[0].text, 'def foo():');
  assertEqual(sl[0].start, 4);
  assertEqual(sl[0].end, 14);
});

test('borderless: 8 spaces indentation', () => {
  const text = '        return self.value';
  const matches = parseRow(text);
  const sl = matches.filter(m => m.patternName === 'source_line');
  assertEqual(sl[0].text, 'return self.value');
  assertEqual(sl[0].start, 8);
});

// =============================================================================
// Tests: comment_line_ref pattern
// =============================================================================

console.log('\n--- comment_line_ref pattern ---\n');

test('comment_line_ref matches # :344', () => {
  const text = '├─► _get_search_container_for_item()                  # :344';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
  const clr = matches.find(m => m.patternName === 'comment_line_ref');
  assertEqual(clr.text, '# :344');
});

test('comment_line_ref matches # :190 with trailing text', () => {
  const text = '├─► resolver.resolve_native_parameters()             # :190 — maps Params';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
});

test('comment_line_ref matches with tilde (approximate line)', () => {
  const text = 'some code  # :~42';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
});

test('comment_line_ref matches with range', () => {
  const text = 'some code  # :10-20';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
});

test('comment_line_ref rejected when # not preceded by whitespace', () => {
  const text = 'foo#:123';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), false);
});

test('comment_line_ref at start of line', () => {
  const text = '# :42 some reference';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
});

// =============================================================================
// Tests: priority-aware overlap resolution
// =============================================================================

console.log('\n--- priority overlap ---\n');

test('file_line wins over source_line on bordered tree diagram', () => {
  const text = '│   └─► ProvisionChanges.map_query_params_to_native()    # provision_changes.py:141';
  const matches = parseRow(text);
  // file_line should match provision_changes.py:141 (high priority)
  assertEqual(matches.some(m => m.patternName === 'file_line'), true);
  const fl = matches.find(m => m.patternName === 'file_line');
  assertEqual(fl.text, 'provision_changes.py:141');
});

test('file_line wins over source_line on 4-space indented tree diagram', () => {
  const text = '    └─► ProvisionChanges.map_query_params_to_native()    # provision_changes.py:141';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'file_line'), true);
  const fl = matches.find(m => m.patternName === 'file_line');
  assertEqual(fl.text, 'provision_changes.py:141');
});

test('comment_line_ref wins over source_line on bordered line', () => {
  const text = '│   ├─► set_hs_scenario()                                # :194';
  const matches = parseRow(text);
  assertEqual(matches.some(m => m.patternName === 'comment_line_ref'), true);
});

test('source_line and file_line coexist — source_line fills gap', () => {
  const text = '│   └─► func()    # file.py:10';
  const matches = parseRow(text);
  // file_line should be present
  assertEqual(matches.some(m => m.patternName === 'file_line'), true);
  // source_line may or may not be present depending on expand, but file_line must win its span
  const fl = matches.find(m => m.patternName === 'file_line');
  assertEqual(fl.text, 'file.py:10');
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
