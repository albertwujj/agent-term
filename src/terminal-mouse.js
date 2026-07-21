const DECORATION_SELECTOR = '.xterm-decoration-overview-container, .xterm-decoration-container';

function isTerminalDecorationTarget(target) {
  return !!target && typeof target.closest === 'function' && target.closest(DECORATION_SELECTOR) !== null;
}

function attachTerminalMouseShortcuts({
  screenElement,
  terminal,
  isClickableMatchEvent,
}) {
  if (!screenElement) return;

  screenElement.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    if (typeof isClickableMatchEvent === 'function' && isClickableMatchEvent(e)) return;
    if (isTerminalDecorationTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    terminal.scrollToBottom();
    terminal.focus();
  });
}

module.exports = {
  attachTerminalMouseShortcuts,
  isTerminalDecorationTarget,
};
