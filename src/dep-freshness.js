const path = require('path');

// npm runs `postinstall` on every install, so the installed tree carries a
// stamp of the lockfile it was built from. A start whose lockfile no longer
// matches that stamp is running against dependencies nobody installed. The
// native modules are the ones that bite: node-pty throws at require time,
// before any window exists, with nothing in the message pointing at the cause.
//
// Content, not mtimes. A branch switch rewrites package-lock.json's timestamp
// without changing a single dependency, and this checkout already shows the
// lockfile newer than npm's own marker on a tree that is perfectly healthy.
const STAMP_FILE = ['node_modules', '.agent-term-lock'];
const LOCK_FILE = 'package-lock.json';

function stampPath(root) {
  return path.join(root, ...STAMP_FILE);
}

function lockPath(root) {
  return path.join(root, LOCK_FILE);
}

function lockStamp({ fs, crypto, root }) {
  return crypto.createHash('sha256').update(fs.readFileSync(lockPath(root))).digest('hex');
}

// Called from postinstall, so the stamp is written exactly when npm has
// finished installing the tree the lockfile describes.
function writeLockStamp({ fs, crypto, root }) {
  const stamp = lockStamp({ fs, crypto, root });
  fs.writeFileSync(stampPath(root), stamp + '\n');
  return stamp;
}

// Returns null when the tree matches the lockfile, or a message naming the fix.
// Both files missing means we cannot judge: a checkout with no lockfile, or a
// tree installed before this check existed. Silence beats crying wolf, and the
// first install after this lands stamps it.
function dependencyProblem({ fs, crypto, root }) {
  let stamped;
  try {
    stamped = fs.readFileSync(stampPath(root), 'utf8').trim();
  } catch {
    return null;
  }
  let current;
  try {
    current = lockStamp({ fs, crypto, root });
  } catch {
    return null;
  }
  if (stamped === current) return null;
  return 'package-lock.json has changed since the last install, so node_modules '
    + 'no longer matches it. Native modules loaded from a mismatched tree fail in '
    + 'ways that point nowhere near the cause, so AgentTerm stops here instead.';
}

module.exports = {
  STAMP_FILE,
  LOCK_FILE,
  stampPath,
  lockPath,
  lockStamp,
  writeLockStamp,
  dependencyProblem,
};
