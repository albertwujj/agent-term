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

// A declared package with no folder in node_modules will throw at require time,
// before any window exists to explain it. That is a different failure from a
// lockfile that merely drifted: one cannot start at all, the other almost
// always runs. Sorting them here is what lets each get the surface it deserves.
function missingDependencies({ fs, root }) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const declared = Object.keys({
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
  });
  return declared.filter((name) => !fs.existsSync(path.join(root, 'node_modules', name)));
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
  // One line, because it is printed into a terminal beside everything else and
  // is advisory: every package is installed, so this session will almost
  // certainly be fine. It exists so that if something does fail later, the
  // reason is already in the scrollback above it.
  return 'package-lock.json has changed since node_modules was installed. '
    + 'Run `npm ci` if anything misbehaves.';
}

module.exports = {
  missingDependencies,
  stampPath,
  lockPath,
  writeLockStamp,
  dependencyProblem,
};
