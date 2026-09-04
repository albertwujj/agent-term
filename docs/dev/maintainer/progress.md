# Progress

## Completed

### Phase 1: Terminal MVP ✅
- Full screen Electron + xterm.js + node-pty
- Shell works (zsh/bash on Mac, WSL on Windows)

### Phase 2: Intelligent Layer (In Progress)
- [x] Pattern detection & decoration system
- [x] Click handling with visual feedback
- [x] Test coverage (45 tests)
- [ ] IDE integration (click opens file)

## What's Next
- Open clicked file:line in IDE (VS Code/Cursor)
- See spec.md for full vision, decisions.md for technical context

## Known Limitations (MVP)
- Decorations never removed (acceptable for append-only output)
- See decisions.md for rationale
