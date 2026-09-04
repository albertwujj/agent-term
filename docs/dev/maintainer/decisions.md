# Decisions

## Stack: Electron + xterm.js + node-pty

**Why not native (Swift/Rust)?**
- Need one codebase for Mac + Windows
- xterm.js has ILinkProvider API for clickable spans (core to Phase 2)
- Shipping speed matters more than native performance

**Why not Tauri?**
- Marginal benefit over Electron for this use case
- Electron ecosystem more mature

**Performance acceptable?**
- xterm.js WebGL is ~2x slower than Windows Terminal/Alacritty
- For Claude Code: doesn't matter—LLM streaming is the bottleneck, not rendering
- Only noticeable on bulk output (cat huge files), not normal usage

## Windows: WSL only

- Both Windows Terminal and Electron+node-pty use same conpty→wslhost→WSL path
- PTY layer identical; only rendering differs
- Native Windows (cmd/PowerShell) not needed for Claude Code workflow

## Intelligent layer approach (Updated)

### Terminology: Lines vs Rows

- **Buffer Line / Row**: A row in xterm.js buffer (fixed width, e.g., 80 chars)
- **Logical Line**: Text ending with newline (may span multiple rows if wrapped)
- xterm.js `getLine(index)` returns buffer rows, not logical lines
- We use "row" to avoid confusion

### Why Decorations API, not ILinkProvider

Initial plan was ILinkProvider, but:
- ILinkProvider only shows underlines on hover (lazy)
- We want proactive underlines before hover
- Solution: Use `terminal.registerDecoration()` for visual + click handling

### Processing Strategy: Simple Append-Only

**Considered approaches:**

1. ❌ Global idle detection (debounce after output stops)
   - Problem: Claude Code streams for long periods
   - Static content at top never gets decorated while bottom streams

2. ❌ Periodic re-parse with hash-based caching
   - Parse every 500ms, hash each row
   - Only re-decorate if hash changed
   - Problem: Complex cache invalidation when rows scroll

3. ✅ **Chosen: Process new rows only, never remove**
   - Track which buffer rows we've processed
   - Only decorate new (unprocessed) rows
   - Never remove decorations

**Why this works for Claude Code:**
- Conversation history is append-only (new lines added, old unchanged)
- In-place changes are rare (progress spinners, "Thinking...")
- Those tend to be gray/de-emphasized anyway
- Stale decoration on rare in-place change is acceptable for MVP

### Row Filtering

**Skip rows at or below cursor:**
- Cursor position indicates where new output is being written
- Rows above cursor are "done" (cursor moved past them)
- Rows at/below cursor might still be receiving input
- Simple rule: `if (row >= cursorRow) skip`

**Skip wrapped rows:**
- `isWrapped=true` means continuation of previous row
- Process with parent row to get full logical line
- Prevents pattern from being split across rows

### Stability Check (Deferred)

Original plan included two-round stability check:
- Only decorate after same hash seen twice (500ms apart)
- Prevents decorating actively changing content

MVP simplification: Skip this for now because:
- "Process new rows only" already avoids actively changing content
- Rows above cursor are stable by definition
- Add stability check later if flickering observed

### Decoration Lifecycle

**Create:** When processing new row with pattern match
**Keep:** Forever (until resize)
**Remove:** Only on terminal resize (clear all, reprocess)

Simpler than tracking/invalidating individual decorations.

### Pattern System

Extensible array of patterns:
```javascript
const patterns = [
  { name: 'underscore_symbol', regex: /.../, action: fn },
  { name: 'file_line', regex: /.../, action: fn },
]
```

Easy to add new patterns (URLs, camelCase, etc.) without changing core logic.
