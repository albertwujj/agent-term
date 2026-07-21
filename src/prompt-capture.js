// User-prompt capture state machine.
//
// Consumes raw bytes the user sends to the PTY (via the pty-input IPC channel)
// and yields each user prompt typed/pasted into the AI CLI. The first prompt
// becomes the session's identity (icon letters, title); follow-up prompts
// feed the activity timeline rendered into the iconic thumbnail.
//
// Capture rules:
//   1. Bracketed paste (\x1b[200~ ... \x1b[201~) -> the inner content is
//      appended to the typed buffer and flagged as `hadPaste`. Capture
//      still waits for Enter, so erases / continued typing after the
//      paste are reflected in the captured prompt. `hadPaste` lets the
//      Enter path bypass the slash-prefix and MIN_TYPED_PROMPT_LEN
//      filters (pastes are deliberate content; short / slash-prefixed
//      pastes are still prompts).
//   2. Otherwise: wait for the OSC-title-arrival "cliStarted" signal (delivered
//      via notifyCliStarted()). Before cliStarted, every Enter discards the
//      buffer (it's a shell command like `claude` or `cd ~/repo`).
//   3. After cliStarted: an Enter is captured ONLY if all hold:
//        - buffer is non-empty after trim
//        - `hadPaste` OR (buffer does NOT start with "/" AND trimmed
//          length >= MIN_TYPED_PROMPT_LEN). Pastes bypass both filters;
//          otherwise we drop slash-commands (/resume, /help, /clear) and
//          short typed input (session-selector filter strings, etc.)
//      An Enter that fails the predicate is silently skipped, the next
//      real input is still capturable.
//   4. Editing: Backspace/DEL drop the last byte. Ctrl+U clears the
//      whole buffer (covers Cmd+Backspace on macOS, which most CLIs
//      map to Ctrl+U). Ctrl+W deletes the trailing word. Arrow/function
//      keys and other escape sequences are stripped — without cursor
//      tracking we can't mirror caret-relative inserts, so the buffer
//      stays append-only between erases.
//
// Tradeoff of MIN_TYPED_PROMPT_LEN: very short genuine prompts ("fix bug",
// 7 chars) are skipped. Most prompts to AI CLIs are sentences and clear it.
//
// State machine outputs are pushed through an onPrompt callback. The machine
// keeps capturing across prompts so timelines stay current. Call markLocked()
// to suspend further capture (used by tests / shutdown paths).
//
// All bytes are tracked as JS strings (the PTY layer hands us strings already).

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MIN_TYPED_PROMPT_LEN = 15;  // chars; tune if short genuine prompts get missed

function isPrintable(charCode) {
  // printable ASCII + extended (Latin-1, common for AI CLI prompts).
  // Exclude DEL (127), C0 (<32), and stray C1 control codes.
  return (charCode >= 32 && charCode < 127) || charCode > 159;
}

function createPromptCapture({ onPrompt, onShellCommand } = {}) {
  let cliStarted = false;
  let locked = false;
  let buf = '';
  let inPaste = false;
  let pasteBuf = '';
  // True when buf contains content from a bracketed paste. Lets the
  // Enter path bypass MIN_TYPED_PROMPT_LEN and the slash-prefix filter,
  // since paste content is deliberate regardless of length.
  let hadPaste = false;

  function emitShellCommand(text) {
    if (typeof onShellCommand !== 'function') return;
    if (locked) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onShellCommand(trimmed);
  }

  function reset() {
    buf = '';
    hadPaste = false;
  }

  function emit(text) {
    if (locked) return;
    const trimmed = text.replace(/\r/g, '').trimEnd();
    if (trimmed.length === 0) return;
    buf = '';
    pasteBuf = '';
    inPaste = false;
    hadPaste = false;
    if (typeof onPrompt === 'function') onPrompt(trimmed);
  }

  function notifyCliStarted() {
    cliStarted = true;
  }

  // Best-effort: skip a CSI sequence (ESC [ ... final-byte). Returns the index
  // just past the consumed bytes. If the sequence is incomplete in this chunk
  // (e.g., just "\x1b" at the end), we drop the partial bytes — input chunks
  // are typically aligned at sequence boundaries from xterm/keyboard.
  function skipEscapeSequence(data, i) {
    // i points at ESC. Look at next char.
    if (i + 1 >= data.length) return data.length;
    const next = data.charCodeAt(i + 1);
    // CSI: ESC [
    if (next === 0x5b /* [ */) {
      let j = i + 2;
      // Param/intermediate bytes 0x30-0x3F, 0x20-0x2F. Final byte 0x40-0x7E.
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) return j + 1;
        j++;
      }
      return data.length;
    }
    // OSC: ESC ] ... ST (BEL or ESC \). Drop entire OSC.
    if (next === 0x5d /* ] */) {
      let j = i + 2;
      while (j < data.length) {
        if (data.charCodeAt(j) === 0x07) return j + 1;
        if (data.charCodeAt(j) === 0x1b && data.charCodeAt(j + 1) === 0x5c) return j + 2;
        j++;
      }
      return data.length;
    }
    // Other escape: skip the next byte.
    return i + 2;
  }

  function handleInput(data) {
    if (locked || typeof data !== 'string') return;

    let i = 0;
    while (i < data.length) {
      // Bracketed paste boundaries.
      if (!inPaste && data.startsWith(PASTE_START, i)) {
        inPaste = true;
        pasteBuf = '';
        i += PASTE_START.length;
        continue;
      }
      if (inPaste && data.startsWith(PASTE_END, i)) {
        inPaste = false;
        const content = pasteBuf;
        pasteBuf = '';
        i += PASTE_END.length;
        // Append paste into the typed buffer and wait for Enter. This is
        // what lets continued editing after the paste (erase + retype,
        // Ctrl+U, append more text) take effect — otherwise we'd capture
        // a snapshot the user later modifies. hadPaste flags the buffer
        // so the Enter path still bypasses MIN_TYPED_PROMPT_LEN and
        // slash-prefix filters: paste content is intentional prompt
        // material regardless of length or leading character.
        if (content.length > 0) {
          buf += content;
          hadPaste = true;
        }
        continue;
      }
      if (inPaste) {
        pasteBuf += data[i];
        i++;
        continue;
      }

      const ch = data[i];
      const code = data.charCodeAt(i);

      // Escape sequence: skip.
      if (ch === ESC) {
        i = skipEscapeSequence(data, i);
        continue;
      }

      // Enter / submit (\r is the dominant submit byte from PTY).
      if (ch === '\r' || ch === '\n') {
        const trimmed = buf.trim();
        if (cliStarted && trimmed.length > 0) {
          // Pastes bypass the slash/length filters since paste content
          // is deliberate (e.g. "/path/to/file" pasted as part of a
          // question, or a short pasted command). Typed-only buffers
          // still get filtered: slash-commands are meta-commands, and
          // short typed input is usually a selector filter.
          if (!hadPaste &&
              (trimmed.startsWith('/') || trimmed.length < MIN_TYPED_PROMPT_LEN)) {
            reset();
            i++;
            continue;
          }
          emit(buf);
          return;
        }
        // Pre-cliStarted Enter with content = a shell command. Surface it so
        // the wiring layer can detect AI-CLI invocations (claude, codex, etc.).
        // Pastes aren't shell commands — skip onShellCommand for them.
        if (!cliStarted && trimmed.length > 0 && !hadPaste) {
          emitShellCommand(trimmed);
        }
        reset();
        i++;
        continue;
      }

      // Backspace / DEL: remove last char from buffer. Once the buffer
      // is fully erased the hadPaste flag is cleared too — anything the
      // user types from here on is "typed", subject to the normal
      // length/slash filters.
      if (code === 0x08 || code === 0x7f) {
        buf = buf.slice(0, -1);
        if (buf.length === 0) hadPaste = false;
        i++;
        continue;
      }

      // Ctrl+U: clear from cursor to start of line. In line-editing
      // CLIs this is the canonical "clear the whole prompt" key, and
      // macOS Cmd+Backspace is commonly bound to it. We don't track
      // cursor position, so clear the entire buffer.
      if (code === 0x15) {
        buf = '';
        hadPaste = false;
        i++;
        continue;
      }

      // Ctrl+W: delete the previous word + any preceding whitespace.
      // macOS Option+Backspace maps to this in many CLIs.
      if (code === 0x17) {
        let end = buf.length;
        while (end > 0 && /\s/.test(buf[end - 1])) end--;
        while (end > 0 && !/\s/.test(buf[end - 1])) end--;
        buf = buf.slice(0, end);
        if (buf.length === 0) hadPaste = false;
        i++;
        continue;
      }

      // Tab: typical for completion in shell, treat as a no-op for buffer.
      if (code === 0x09) {
        i++;
        continue;
      }

      // Other C0 controls: ignore.
      if (code < 32) {
        i++;
        continue;
      }

      if (isPrintable(code)) {
        buf += ch;
      }
      i++;
    }
  }

  // Force the capture into the "locked" state without firing onPrompt.
  function markLocked() {
    locked = true;
    buf = '';
    pasteBuf = '';
    inPaste = false;
    hadPaste = false;
  }

  return {
    handleInput,
    notifyCliStarted,
    markLocked,
    isLocked: () => locked,
    _state: () => ({ cliStarted, locked, buf, inPaste, pasteBuf, hadPaste }),
  };
}

module.exports = { createPromptCapture };
