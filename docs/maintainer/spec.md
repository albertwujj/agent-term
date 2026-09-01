# agent-term

Terminal app optimized for Claude Code / Cursor CLI with intelligent clickable spans.

## Vision

Detect file:line patterns in terminal output and make them clickable to jump to IDE (on separate monitor/desktop). Lazy-parses stable text only—skips moving/scrolling output.

## Platforms

- macOS: native
- Windows: WSL only

## Phases

### Phase 1: Terminal MVP

Boring but correct terminal. No intelligence yet.

**Done when:**
- Full screen window with shell prompt (zsh/bash on Mac, WSL on Windows)
- `pwd`, `ls`, `git status` work
- `claude` and `cursor` CLI run and stream normally
- Ctrl+C interrupts
- Backspace, arrows, Ctrl+R history work
- Mouse select + copy/paste works

### Phase 2: Intelligent layer

- Detect file:line patterns (line number required)
- Resolve path from filename by searching repo
- Click → open in IDE
- Only parse stable text (debounce after output stops)

## Simplifications

- Full screen only (IDE on separate monitor/desktop)
- Dark mode only
- No tabs/panes
- No settings UI
