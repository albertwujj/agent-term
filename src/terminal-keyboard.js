const { isFindShortcut } = require('./search-shortcut');

function copySelectionToClipboard({ terminal, writeClipboardText }) {
  writeClipboardText(terminal.getSelection());
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

  if (platform === 'win32') {
    if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.shiftKey && terminal.hasSelection()) {
      copySelectionToClipboard({ terminal, writeClipboardText });
      return false;
    }

    if (key === 'c' && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      if (terminal.hasSelection()) {
        copySelectionToClipboard({ terminal, writeClipboardText });
        return false;
      }
      // Under app mouse capture the live selection is often already cleared (any
      // reported mouse event counts as user input) — copy the armed snapshot
      // instead of letting Ctrl+C fall through as an interrupt. Copying disarms,
      // so a second Ctrl+C interrupts — same two-step as with a live selection.
      if (typeof copyArmedSelection === 'function' && copyArmedSelection()) return false;
    }

    if (key === 'v' && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      pasteFromClipboard();
      return false;
    }
  }

  if (isMac) {
    if (key === 'c' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (terminal.hasSelection()) {
        copySelectionToClipboard({ terminal, writeClipboardText });
        return false;
      }
      if (typeof copyArmedSelection === 'function' && copyArmedSelection()) return false;
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
