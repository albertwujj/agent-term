function shouldInsertCaretPositionShortcut(input, platform) {
  if (!input || input.type !== 'keyDown') return false;

  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (key !== 'k' || input.alt || input.shift) return false;

  const isMac = platform === 'darwin';
  if (isMac) {
    return !!input.meta && !input.control;
  }

  return !!input.control && !input.meta;
}

function shouldShowCaretDiagnosticsShortcut(input, platform) {
  if (!input || input.type !== 'keyDown') return false;

  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (key !== 'k' || input.shift || !input.alt) return false;

  const isMac = platform === 'darwin';
  if (isMac) {
    return !!input.meta && !input.control;
  }

  return !!input.control && !input.meta;
}

module.exports = {
  shouldInsertCaretPositionShortcut,
  shouldShowCaretDiagnosticsShortcut,
};
