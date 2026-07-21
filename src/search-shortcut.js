function isFindShortcut(event, platform) {
  if (!event || event.type !== 'keydown') return false;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  const isMac = platform === 'darwin';
  return key === 'f'
    && !event.shiftKey
    && !event.altKey
    && (
      (event.ctrlKey && !event.metaKey)
      || (isMac && event.metaKey && !event.ctrlKey)
    );
}

module.exports = {
  isFindShortcut,
};
