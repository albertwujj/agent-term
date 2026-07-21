# Clickable Patterns Reference

This document describes the patterns detected in terminal output and made clickable for IDE navigation.

## Supported Patterns

### File:Line Patterns

These patterns navigate to a specific file and line number in the IDE.

| Pattern | Name | Example | Source |
|---------|------|---------|--------|
| Python traceback | `python_traceback` | `File "app.py", line 42` | Python errors |
| GitHub line | `github_line` | `file.js#L42` or `file.js#L42-L50` | GitHub links |
| File:line:column | `file_line_col` | `src/main.ts:42:15` | TypeScript, ESLint |
| Parentheses | `paren_line` | `file.js(42)` or `file.js(42,15)` | MSBuild, some compilers |
| Basic file:line | `file_line` | `src/main.js:42` | Most tools, stack traces |

### Symbol Patterns

| Pattern | Name | Example | Action |
|---------|------|---------|--------|
| Qualified symbol | `qualified_symbol` | `Class.method`, `pkg.mod.Class` | Navigate via symbol API |
| Underscore identifier | `underscore_symbol` | `my_var`, `_private` | Navigate via symbol API |
| camelCase/PascalCase | `camel_pascal_symbol` | `myVar`, `HttpResponse` | Navigate via symbol API |

## Pattern Details

### `python_traceback`
```
File "path/to/file.py", line 42
File "/absolute/path.py", line 100
File "./relative/path.py", line 5
```
Regex: `/File "([^"]+)", line (\d+)/g`

### `github_line`
```
src/main.js#L42
lib/utils.ts#L10-L20
```
Regex: `/[a-zA-Z0-9_.\/-]+\.[a-zA-Z]+#L(\d+)(?:-L\d+)?/g`

Note: For line ranges (`#L10-L20`), navigates to the start line.

### `file_line_col`
```
src/main.ts:42:15
/project/src/index.js:10:3
```
Regex: `/[a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]+:\d+:\d+/g`

Note: Column is parsed but not currently used for navigation.

### `paren_line`
```
Program.cs(25)
main.js(42,15)
src/utils/helper.cs(100)
```
Regex: `/[a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]+\(\d+(?:,\s*\d+)?\)/g`

### `file_line`
```
src/main.js:42
./file.py:10
/absolute/path.rs:100
Makefile:10
Dockerfile:5
```
Regex: `/(?:[.\/]|[a-zA-Z])[a-zA-Z0-9_.\/-]*(?:\.[a-zA-Z0-9]+)?:\d+(?!:\d)/g`

Supports:
- Relative paths (`src/foo.js:10`)
- Absolute paths (`/home/user/foo.js:10`)
- Dot-relative paths (`./foo.js:10`, `../foo.js:10`)
- Extensionless files (`Makefile:10`, `Dockerfile:5`)

## Overlap Resolution

When multiple patterns match overlapping text, the algorithm resolves conflicts:

1. **Sort** matches by start position, then by length (longer first for same start)
2. **Filter** overlaps: keep earlier/longer matches, discard overlapping shorter/later ones

**Rules:**
- Longer match wins over embedded shorter match
- Earlier start wins for same-length overlapping matches
- First pattern in array wins for identical spans
- Non-overlapping matches are all kept

**Examples:**

| Input | Competing Matches | Winner |
|-------|-------------------|--------|
| `src/main.ts:42:15` | `file_line_col` (15ch) vs `file_line` (14ch) | `file_line_col` (longer) |
| `src/my_func.py:10` | `file_line` (full) vs `my_func` (embedded) | `file_line` (longer) |
| `MyClass.my_method` | `qualified_symbol` (full) vs `my_method` (partial) | `qualified_symbol` (longer) |
| `my_func and your_func` | Both `underscore_symbol` | Both kept (no overlap) |

Implementation: `parseRow()` in `src/renderer.js`

## Pattern Details: Symbol Patterns

### `qualified_symbol`
```
MyClass.my_method
MyClass.data_attr
module.function
pkg.mod.Class.method
os.path
sys.argv
```
Regex: `/\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+\b/g`

Matches any identifier with 2+ dot-separated segments. No capitalization restriction - allows `module.func`, `Class.method`, `pkg.mod.Class.attr`. The plugin API handles resolution by splitting on dots and matching from the right.

**Filter:** Excludes matches ending with common file extensions to avoid false positives like `foo.ts`, `config.json`. Filtered extensions include: js, ts, jsx, tsx, py, rb, rs, go, java, c, h, cpp, cs, json, yaml, md, html, css, sql, and more.

Symbol API request: `{"type": "symbol", "name": "MyClass.my_method"}`

### `underscore_symbol`
```
my_var
_private
__dunder__
value_
```
Regex: `/\b_[a-zA-Z0-9_]+\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*\b/g`

Matches identifiers containing underscores: either starting with underscore or containing an underscore.

Symbol API request: `{"type": "symbol", "name": "my_var"}`

### `camel_pascal_symbol`
```
myVar
getUserName
parseJSON
MyClass
HttpResponse
StringBuilder
```
Regex: `/\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g`

Matches identifiers using camelCase or PascalCase naming conventions. Common in JavaScript, TypeScript, Java, C#, and other languages.

- **camelCase branch** `[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*`: starts lowercase, must contain at least one uppercase letter. Matches: `myVar`, `getUserName`, `parseJSON`.
- **PascalCase branch** `[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*`: starts uppercase, has lowercase then another uppercase. Requires 2+ "words" to avoid matching plain English words like `Error`, `File`. Matches: `MyClass`, `HttpResponse`, `StringBuilder`.

**Filter:**
- Rejects matches shorter than 4 characters (e.g., `aB`) to reduce noise
- Excludes matches followed by a file extension (e.g., `MyClass.js`)
- Excludes matches that are part of a file path (preceded/followed by `/` or `\`)

Symbol API request: `{"type": "symbol", "name": "myVar"}`

## File Context Hints

Symbol navigation requests include a `fileHint` parameter when file context is available. This helps the IDE disambiguate symbols that appear in multiple files.

### How It Works

1. **Context tracking:** When processing terminal rows, any file:line pattern (e.g., `src/models.py:42`) updates the `lastFileContext` to `src/models.py`.

2. **Context inheritance:** Symbol matches on subsequent rows inherit this context.

3. **Hint inclusion:** When a symbol is clicked, the request includes `fileHint`:
   ```json
   {"type": "symbol", "name": "my_helper", "fileHint": "src/models.py"}
   ```

4. **Soft matching:** The IDE uses suffix-based matching. If hint matches some results, filter to those; if none match, hint is ignored.

5. **Context reset:** File context resets on terminal resize/clear.

### Example

Claude Code output:
```
src/models.py:42
    def save(self):
        my_helper()     <-- clicking sends fileHint: "src/models.py"
```

### Validation

Not all file:line matches set context. The extracted file path must look like a real file:
- Contains `/` (path separator), OR
- Has a known extension (`.py`, `.js`, `.ts`, etc.)

This prevents false positives like `foo:42` (where `foo` could be anything) from polluting the context.

### Known Extensions

Extensions recognized as file paths:
```
js, ts, jsx, tsx, mjs, cjs, py, pyc, pyi, rb, rs, go, java, class,
c, h, cpp, hpp, cc, cs, swift, kt, scala, php, pl, sh, bash, zsh,
json, xml, yaml, yml, toml, ini, cfg, md, txt, rst, html, htm,
css, scss, sass, less, sql, log, lock, bak, tmp, old, orig
```

## Adding a New Pattern

1. Add pattern definition to the `patterns` array in `src/renderer.js`:

```javascript
{
  name: 'my_pattern',
  regex: /your-regex-here/g,  // Must have 'g' flag
  // Optional: filter function to exclude certain matches
  filter: (text) => {
    // Return true to keep, false to exclude
    return !text.endsWith('.excluded');
  },
  action: async (match) => {
    // match object contains: text, patternName, start, end, fileContext
    const filePath = /* extract from match.text */;
    const line = /* extract line number */;
    await navigateToFileLine(filePath, line);
    // For symbols: await navigateToSymbol(match.text, match.fileContext);
  },
},
```

**Note:** The `filter` function runs before decoration creation. Use it to exclude matches that would confuse users (e.g., `foo.ts` looking like a filename rather than a qualified symbol). Matches excluded by filter won't be underlined.

2. Add unit tests in `test/patterns.test.js`:
   - Add regex to the `patterns` array at top of file
   - Add test section with positive and negative cases

3. Order matters: More specific patterns should come before general ones to ensure correct overlap resolution.

## Testing

Run pattern tests:
```bash
npm test
```

Test categories in `test/patterns.test.js`:
- Individual pattern matching (per pattern)
- Filter functionality (extension exclusion)
- Overlap resolution (embedded, same-length, same-start)
- Coordinate calculation (row/col mapping)
- Row filtering logic (cursor position, wrapped lines)
- File context tracking (`isLikelyFilePath`, `extractFilePath`)

Test in terminal:
```bash
echo 'File "test.py", line 10'     # python_traceback
echo 'src/main.js#L15'              # github_line
echo 'src/main.ts:10:5'             # file_line_col
echo 'main.js(20)'                  # paren_line
echo 'src/main.js:10'               # file_line
echo 'MyClass.my_method'            # qualified_symbol
echo 'os.path'                      # qualified_symbol
echo 'my_function'                  # underscore_symbol
echo '_private_var'                 # underscore_symbol
echo 'foo.ts'                       # filtered out (file extension)
echo 'myVar'                        # camel_pascal_symbol
echo 'getUserName'                  # camel_pascal_symbol
echo 'HttpResponse'                 # camel_pascal_symbol
echo 'Error'                        # no match (single word)
```
