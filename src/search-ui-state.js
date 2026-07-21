function getSearchNavigationState({ isAltScreenSearchMode }) {
  const disabled = !!isAltScreenSearchMode;
  return {
    disabled,
    hidden: disabled,
  };
}

function shouldNavigateSearchResults({ isAltScreenSearchMode, matchCount }) {
  return !isAltScreenSearchMode && matchCount > 0;
}

function getSearchCountText({
  isLoading,
  isAltScreenSearchMode,
  query,
  matchCount,
  liveCount,
  historyCount,
  currentIndex,
}) {
  if (isLoading) {
    return 'Searching...';
  }

  if (isAltScreenSearchMode) {
    if (!query) {
      return 'In alt screen: current screen only';
    }

    if (liveCount > 0) {
      return `${liveCount} matches • in alt screen, current screen only`;
    }

    return 'No results • in alt screen, current screen only';
  }

  if (matchCount === 0) {
    return query ? 'No results' : '';
  }

  if (historyCount > 0) {
    return `${currentIndex + 1} of ${matchCount} • ${historyCount} history`;
  }

  return `${currentIndex + 1} of ${matchCount}`;
}

module.exports = {
  getSearchNavigationState,
  getSearchCountText,
  shouldNavigateSearchResults,
};
