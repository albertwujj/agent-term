// User-prompt capture state machine.
//
// Consumes raw bytes the user sends to the PTY (via the pty-input IPC channel)
// and yields each user prompt typed/pasted into the AI CLI. The first prompt
// becomes the session's identity (icon letters, title); follow-up prompts
// feed the activity timeline rendered into the iconic thumbnail.
//
// Capture rules:
//   1. Bracketed paste (\x1b[200~ ... \x1b[201~) -> the inner content is
//      inserted at the caret and flagged as `hadPaste`. Capture
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
//          length >= MIN_TYPED_PROMPT_LEN AND it is not the pick in the
//          CLI's resume dialog). Pastes bypass every filter; otherwise
//          we drop slash-commands (/resume, /help, /clear) and one-key or
//          one-word answers (y, 1, ok, yes).
//      A bare typed @name is a mention-picker query, also skipped. Its
//      acceptance Enter is not the prompt submission. Explicit paths
//      (@dir/file, @file.md), prose containing mentions, and pastes still
//      count. A renderer snapshot can recover the completed @ token on
//      the later submission, but only on the same prompt row as its
//      typed query (prompt-completion.js). Suggestions/output never seed
//      a separate collection of session files.
//      A typed "/resume" opens the CLI's resume dialog, where the user may
//      type a search filter and then presses Enter to pick. That Enter is
//      the pick, never a prompt, whatever the filter's length, so it is
//      skipped; a bare Esc or Ctrl+C closes the dialog instead and puts
//      the next Enter back at the input line. Only /resume gets this: the
//      other dialogs are navigated with arrows (an empty Enter), and the
//      Enter after an inline command (/clear, /compact, /cost) is the next
//      prompt, which may well be short ("generate more").
//      An Enter that fails the predicate is silently skipped, the next
//      real input is still capturable.
//   4. Editing: track the caret for Left/Right, Home/End, word movement,
//      and their readline control-key equivalents. Typing, paste,
//      Backspace/Delete and Ctrl+U/W/K edit at that caret, so a prefix
//      inserted after the rest of a prompt still appears first. Other
//      escape sequences are stripped; history and vertical navigation
//      cannot reconstruct text that never passed through this capture.
//
// Tradeoff of MIN_TYPED_PROMPT_LEN: a typed line this short is taken for a
// dialog answer, so a two- or three-letter prompt ("why", "go") is skipped
// and the next one becomes the identity. Anything with a word and a bit
// more clears it. The floor used to be 15, meant to catch the resume
// dialog's filter strings; it caught "generate more" instead, and the
// session's identity became the prompt after it. The pick is now
// recognised by what precedes it (rule 3), not by its length.
// The old floor also happened to drop short @-completion queries. Keep
// that filter separate so lowering the floor does not name a session
// after a query such as "@pr-rev". Without a matching rendered prompt,
// a bare extensionless mention on its own remains ambiguous; paste it or
// use an explicit path to capture it.
//
// State machine outputs are pushed through an onPrompt callback. The machine
// keeps capturing across prompts so timelines stay current. Call markLocked()
// to suspend further capture (used by tests / shutdown paths).
//
// All bytes are tracked as JS strings (the PTY layer hands us strings already).

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MIN_TYPED_PROMPT_LEN = 4;   // chars; below this a typed line is a dialog answer, not a prompt
const { beginMentionCompletion, recoverMentionCompletion } = require('./prompt-completion');

function isPrintable(charCode) {
  // printable ASCII + extended (Latin-1, common for AI CLI prompts).
  // Exclude DEL (127), C0 (<32), and stray C1 control codes.
  return (charCode >= 32 && charCode < 127) || charCode > 159;
}

// The slash command that opens the CLI's resume dialog: "/resume" alone or
// with arguments. Every supported CLI (claude, codex, agent, copilot) names
// it so.
function isResumeCommand(trimmed) {
  return /^\/resume(\s|$)/.test(trimmed);
}

function createPromptCapture({ onPrompt, onShellCommand } = {}) {
  let cliStarted = false;
  let locked = false;
  let buf = '';
  let cursor = 0; // UTF-16 offset in buf; movement respects surrogate pairs
  let inPaste = false;
  let pasteBuf = '';
  // True when buf contains content from a bracketed paste. Lets the
  // Enter path bypass MIN_TYPED_PROMPT_LEN and the slash-prefix filter,
  // since paste content is deliberate regardless of length.
  let hadPaste = false;
  // True between a typed /resume and the Enter that picks in the dialog it
  // opened (or the Esc / Ctrl+C that closes it). Nothing typed in between
  // is a prompt: it is the dialog's search filter.
  let inResumeDialog = false;
  let mentionCompletion = null;

  function emitShellCommand(text) {
    if (typeof onShellCommand !== 'function') return;
    if (locked) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onShellCommand(trimmed);
  }

  function reset() {
    buf = '';
    cursor = 0;
    hadPaste = false;
    mentionCompletion = null;
  }

  function insert(text) {
    buf = buf.slice(0, cursor) + text + buf.slice(cursor);
    cursor += text.length;
  }

  function erase(start, end) {
    buf = buf.slice(0, start) + buf.slice(end);
    cursor = start;
    mentionCompletion = null;
    if (!buf.length) hadPaste = false;
  }

  function previousChar(at) {
    if (at === 0) return 0;
    return at > 1 && /[\uDC00-\uDFFF]/.test(buf[at - 1]) && /[\uD800-\uDBFF]/.test(buf[at - 2])
      ? at - 2 : at - 1;
  }

  function nextChar(at) {
    return Math.min(buf.length, at + (buf.codePointAt(at) > 0xffff ? 2 : 1));
  }

  function previousWord(at) {
    while (at > 0 && /\s/.test(buf[at - 1])) at = previousChar(at);
    while (at > 0 && !/\s/.test(buf[at - 1])) at = previousChar(at);
    return at;
  }

  function nextWord(at) {
    while (at < buf.length && /\s/.test(buf[at])) at = nextChar(at);
    while (at < buf.length && !/\s/.test(buf[at])) at = nextChar(at);
    return at;
  }

  function lineStart() { return cursor > 0 ? buf.lastIndexOf('\n', cursor - 1) + 1 : 0; }
  function lineEnd() {
    const end = buf.indexOf('\n', cursor);
    return end < 0 ? buf.length : end;
  }

  function move(direction, count = 1, byWord = false) {
    const step = direction < 0
      ? (byWord ? previousWord : previousChar) : (byWord ? nextWord : nextChar);
    // Clamp counts from escape parameters to the largest useful movement.
    for (let n = 0; n < Math.min(count, buf.length); n++) cursor = step(cursor);
  }

  function editEscape(sequence) {
    const csi = /^\x1b\[([0-9;]*)([CDHF~])$/.exec(sequence);
    const ss3 = /^\x1bO([CDHF])$/.exec(sequence);
    if (sequence === '\x1bb') cursor = previousWord(cursor);
    else if (sequence === '\x1bf') cursor = nextWord(cursor);
    else if (csi || ss3) {
      const params = csi ? csi[1].split(';').map(Number) : [];
      const key = csi ? csi[2] : ss3[1];
      const byWord = params[1] === 3 || params[1] === 5; // Alt / Ctrl
      if (key === 'D') move(-1, params[0] || 1, byWord);
      else if (key === 'C') move(1, params[0] || 1, byWord);
      else if (key === 'H' || (key === '~' && [1, 7].includes(params[0]))) cursor = lineStart();
      else if (key === 'F' || (key === '~' && [4, 8].includes(params[0]))) cursor = lineEnd();
      else if (key === '~' && params[0] === 3) erase(cursor, nextChar(cursor));
    }
  }

  function emit(text) {
    if (locked) return;
    const trimmed = text.replace(/\r/g, '').trimEnd();
    if (trimmed.length === 0) return;
    reset();
    pasteBuf = '';
    inPaste = false;
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
    // Application-mode arrows/Home/End use SS3 (ESC O final-byte).
    if (next === 0x4f /* O */) return Math.min(i + 3, data.length);
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

  function handleInput(data, promptSnapshot = null) {
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
        // Insert paste into the typed buffer and wait for Enter. This is
        // what lets continued editing after the paste (erase + retype,
        // Ctrl+U, append more text) take effect — otherwise we'd capture
        // a snapshot the user later modifies. hadPaste flags the buffer
        // so the Enter path still bypasses MIN_TYPED_PROMPT_LEN and
        // slash-prefix filters: paste content is intentional prompt
        // material regardless of length or leading character.
        if (content.length > 0) {
          insert(content);
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

      // Escape sequence: skip. A bare Esc (the key itself, nothing after it
      // in the chunk) closes whatever dialog is up; the next Enter is back
      // at the input line.
      if (ch === ESC) {
        // Moving the caret invalidates the remembered completion's position.
        // Resume-dialog navigation is unchanged.
        if (/^\x1b(?:\[[0-9;]*[ABCDHF]|\[(?:1|3|4|7|8)(?:;[0-9]+)?~|O[ABCDHF]|[bf])/.test(data.slice(i))) {
          mentionCompletion = null;
        }
        if (i + 1 >= data.length) {
          inResumeDialog = false;
          mentionCompletion = null;
        }
        const end = skipEscapeSequence(data, i);
        editEscape(data.slice(i, end));
        i = end;
        continue;
      }

      // Enter / submit (\r is the dominant submit byte from PTY).
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i + 1] === '\n') i++; // CRLF is one Enter
        const bareQuery = /^@[\w-]+$/u.test(buf.trim());
        const tabCompletedQuery = mentionCompletion?.typedPrefix === buf && buf.length > 0;
        const recovered = cliStarted && !inResumeDialog
          ? recoverMentionCompletion(buf, mentionCompletion, promptSnapshot) : null;
        if (recovered !== null) { buf = recovered; cursor = buf.length; }
        const trimmed = buf.trim();
        // The Enter after a typed /resume is the pick in the resume dialog,
        // with the search filter (of any length) in the buffer, or nothing
        // when the user arrowed to it. Never a prompt.
        if (cliStarted && inResumeDialog) {
          inResumeDialog = false;
          reset();
          i++;
          continue;
        }
        if (cliStarted && trimmed.length > 0) {
          // Pastes bypass the slash/length filters since paste content
          // is deliberate (e.g. "/path/to/file" pasted as part of a
          // question, or a short pasted command). Typed-only buffers
          // still get filtered: slash-commands are meta-commands, and a
          // line of a few characters is a dialog answer.
          if (!hadPaste && trimmed.startsWith('/')) {
            if (isResumeCommand(trimmed)) inResumeDialog = true;
            reset();
            i++;
            continue;
          }
          if (!hadPaste && bareQuery && !(tabCompletedQuery && recovered !== null)) {
            const completion = beginMentionCompletion(buf, promptSnapshot);
            reset();
            mentionCompletion = completion;
            i++;
            continue;
          }
          if (!hadPaste && trimmed.length < MIN_TYPED_PROMPT_LEN) {
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

      // Backspace / DEL: remove the character before the caret. Once the buffer
      // is fully erased the hadPaste flag is cleared too — anything the
      // user types from here on is "typed", subject to the normal
      // length/slash filters.
      if (code === 0x08 || code === 0x7f) {
        erase(previousChar(cursor), cursor);
        i++;
        continue;
      }

      // Readline movement: Ctrl+A/E (line start/end), Ctrl+B/F (left/right).
      if ([0x01, 0x05, 0x02, 0x06].includes(code)) {
        mentionCompletion = null;
        if (code === 0x01) cursor = lineStart();
        else if (code === 0x05) cursor = lineEnd();
        else move(code === 0x02 ? -1 : 1);
        i++;
        continue;
      }

      // Ctrl+D deletes forward; Ctrl+K kills from the caret to line end.
      if (code === 0x04 || code === 0x0b) {
        erase(cursor, code === 0x04 ? nextChar(cursor) : lineEnd());
        i++;
        continue;
      }

      // Ctrl+U: clear from cursor to start of line (also Cmd+Backspace).
      if (code === 0x15) {
        erase(lineStart(), cursor);
        i++;
        continue;
      }

      // Ctrl+W: delete the previous word + any trailing whitespace.
      // macOS Option+Backspace maps to this in many CLIs.
      if (code === 0x17) {
        erase(previousWord(cursor), cursor);
        i++;
        continue;
      }

      // Tab can accept an @ completion too. Remember its query and input
      // row, keeping the raw bytes intact until a later Enter confirms
      // the expanded token in that prompt.
      if (code === 0x09) {
        if (cliStarted && !inResumeDialog && cursor === buf.length) {
          const recovered = recoverMentionCompletion(buf, mentionCompletion, promptSnapshot);
          mentionCompletion = beginMentionCompletion(recovered || buf, promptSnapshot, true);
          if (mentionCompletion) mentionCompletion.typedPrefix = buf;
        }
        i++;
        continue;
      }

      // Ctrl+C: closes an open dialog (and clears the line at the input
      // line). Either way the next Enter is at the input line. Before the
      // CLI, the shell drops its line the same way, so a launch line the
      // picker typed and the user cancelled is not read at the next Enter.
      if (code === 0x03) {
        inResumeDialog = false;
        reset();
        i++;
        continue;
      }

      // Other C0 controls: ignore.
      if (code < 32) {
        mentionCompletion = null; // unknown editing/history operations
        i++;
        continue;
      }

      if (isPrintable(code)) {
        insert(ch);
      }
      i++;
    }
  }

  // Force the capture into the "locked" state without firing onPrompt.
  function markLocked() {
    locked = true;
    reset();
    pasteBuf = '';
    inPaste = false;
    inResumeDialog = false;
  }

  return {
    handleInput,
    notifyCliStarted,
    markLocked,
    isLocked: () => locked,
    _state: () => ({ cliStarted, locked, buf, inPaste, pasteBuf, hadPaste, inResumeDialog }),
  };
}

module.exports = { createPromptCapture };
