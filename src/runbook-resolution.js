const path = require('path');

function normalizedRelativeRunbookPath(relativeRunbookPath) {
  const value = String(relativeRunbookPath || '');
  const normalized = path.posix.normalize(value);
  if (!value || path.posix.isAbsolute(value) || normalized !== value || normalized === '.'
      || normalized.split('/').includes('..')) {
    throw new Error('relativeRunbookPath must be a normalized relative POSIX path');
  }
  return normalized;
}

// Build the deterministic lookup ladder shared by every host-resolved
// runbook. The governed file's direct ancestor chain is authoritative and is
// ordered nearest-first. Fallback roots are exact, ordered locations (for
// example, the current repo, its parent, and then $HOME), never recursive
// searches; stable deduplication keeps any naturally-nearer occurrence.
function orderedRunbookCandidates({ referenceFile, relativeRunbookPath, fallbackRoots = [] } = {}) {
  const reference = String(referenceFile || '');
  if (!path.posix.isAbsolute(reference)) {
    throw new Error('referenceFile must be an absolute POSIX path');
  }
  const relative = normalizedRelativeRunbookPath(relativeRunbookPath);
  const candidates = [];
  const seen = new Set();
  const addRoot = (root) => {
    const value = String(root || '');
    if (!path.posix.isAbsolute(value)) {
      throw new Error('fallback roots must be absolute POSIX paths');
    }
    const candidate = path.posix.join(path.posix.normalize(value), relative);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };

  let dir = path.posix.dirname(path.posix.normalize(reference));
  for (;;) {
    addRoot(dir);
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of fallbackRoots) addRoot(root);
  return candidates;
}

// A runbook repository can be vendored at the repo root, sit beside it (a
// sibling), or live anywhere up the tree. Walk the anchor's full ancestor chain,
// closest-first: joined with the relative path these roots cover the vendored
// (root/…), sibling/beside (parent/…), and further-up locations. Callers append
// HOME after them when building the complete fallback list.
function repoRunbookRoots(repoRoot) {
  const value = String(repoRoot || '');
  if (!path.posix.isAbsolute(value)) {
    throw new Error('repoRoot must be an absolute POSIX path');
  }
  const roots = [];
  let dir = path.posix.normalize(value);
  for (;;) {
    roots.push(dir);
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

module.exports = {
  orderedRunbookCandidates,
  repoRunbookRoots,
};
