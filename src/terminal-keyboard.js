const { isFindShortcut } = require('./search-shortcut');
const { smartCopyText } = require('./smart-copy');

// `transform` rewrites the selection before it reaches the clipboard: the copy
// chord passes smartCopyText, the Shift chord passes nothing and keeps the
// terminal layout.
function copySelectionToClipboard({ terminal, writeClipboardText, transform }) {
  const text = terminal.getSelection();
  writeClipboardText(transform ? transform(text) : text);
  const scrollY = terminal.buffer.active.viewportY;
  terminal.clearSelection();
  terminal.scrollToLine(scrollY);
}

function handleTerminalKeydown({
  event,
  terminal,
  platform,
  searchState,
  getSearchState,
  openSearchBar,
  closeSearchBar,
  pasteFromClipboard,
  writeClipboardText,
  copyArmedSelection,
}) {
  if (event.type !== 'keydown') return true;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  const isMac = platform === 'darwin';
  const currentSearchState = typeof getSearchState === 'function' ? getSearchState() : searchState;

  // Ctrl+F on Windows/Linux and Cmd+F on macOS.
  if (isFindShortcut(event, platform)) {
    event.preventDefault();
    openSearchBar();
    return false;
  }

  if (event.key === 'Escape' && currentSearchState && currentSearchState.isOpen) {
    closeSearchBar();
    return false;
  }

  // Copy the selection. The platform's copy chord copies it as message text
  // (src/smart-copy.js): gutter and wraps gone, which is what a selection of
  // agent output is usually for. Shift added keeps the terminal layout, the
  // copy to take for code. Both take the live selection first. Under app mouse
  // capture the live selection is often already cleared (any reported mouse
  // event counts as user input), so both fall back to the armed snapshot
  // instead of letting the chord reach the shell. Copying disarms, so a second
  // Ctrl+C on Windows interrupts — the same two-step as with a live selection.
  // The Shift chord is swallowed even with nothing to copy: it only ever means
  // copy, and on Windows a fall-through would reach the pty as Ctrl+C and
  // interrupt the agent.
  const copy = (transform) => {
    if (terminal.hasSelection()) {
      copySelectionToClipboard({ terminal, writeClipboardText, transform });
      return true;
    }
    return typeof copyArmedSelection === 'function' && copyArmedSelection(transform);
  };

  if (platform === 'win32') {
    // The console's copy gesture, so the same copy as Ctrl+C.
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.shiftKey && terminal.hasSelection()) {
      copySelectionToClipboard({ terminal, writeClipboardText, transform: smartCopyText });
      return false;
    }

    if (key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.shiftKey) {
        event.preventDefault();
        copy();
        return false;
      }
      if (copy(smartCopyText)) return false;
    }

    if (key === 'v' && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      pasteFromClipboard();
      return false;
    }
  }

  if (isMac) {
    if (key === 'c' && event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.shiftKey) {
        event.preventDefault();
        copy();
        return false;
      }
      if (copy(smartCopyText)) return false;
    }

    if (key === 'v' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      pasteFromClipboard();
      return false;
    }
  }

  return true;
}

module.exports = {
  copySelectionToClipboard,
  handleTerminalKeydown,
};
