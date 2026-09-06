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

// Two kinds of missing package, and only one of them can stop a launch.
//
// The runtime set is what this process and its startup build actually load:
// everything in `dependencies`, plus esbuild, which rebuilds the renderer
// bundles on a from-source start. `electron` is deliberately not in it — by the
// time this code runs, Electron is the process.
//
// The rest of what is declared (electron-builder, @electron/rebuild, jsdom,
// playwright-core) belongs to packaging and the test suites. A window runs
// perfectly without them, so their absence is worth a line and never a stop:
// blocking there would refuse a working terminal over a test dependency.
const LAUNCH_TOOLS = ['esbuild'];

// `require` searches every node_modules up the tree, so a folder missing from
// ours is not yet a missing package: a clone under a workspace root that hoists
// its packages resolves upward and runs. Ask Node the question we actually
// mean, which is whether the require would throw.
function defaultResolve(name, root) {
  try {
    require.resolve(name, { paths: [root] });
    return true;
  } catch (err) {
    // Anything but "not found" means Node located the package and objected to
    // something else, an exports map without a main entry being the usual one.
    // That package is installed.
    return !err || err.code !== 'MODULE_NOT_FOUND';
  }
}

function declaredPackages({ fs, root }) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return { runtime: [], tooling: [] };
  }
  const runtime = Object.keys(manifest.dependencies || {});
  const tooling = [];
  for (const name of Object.keys(manifest.devDependencies || {})) {
    (LAUNCH_TOOLS.includes(name) ? runtime : tooling).push(name);
  }
  return { runtime, tooling };
}

function absentPackages({ fs, resolve = defaultResolve, root }, names) {
  return names.filter((name) => !fs.existsSync(path.join(root, 'node_modules', name))
    && !resolve(name, root));
}

// A package the launch path loads throws at require time, before any window
// exists to explain it. That is a different failure from a lockfile that merely
// drifted: one cannot start at all, the other almost always runs. Sorting them
// here is what lets each get the surface it deserves.
function missingRuntimeDependencies({ fs, resolve, root }) {
  return absentPackages({ fs, resolve, root }, declaredPackages({ fs, root }).runtime);
}

// Declared, absent, and needed by nothing this window does. One advisory line,
// so a failed `npm ci` on a test dependency is visible before the suite fails
// on it rather than after.
function toolingProblem({ fs, resolve, root }) {
  const missing = absentPackages({ fs, resolve, root }, declaredPackages({ fs, root }).tooling);
  if (!missing.length) return null;
  const one = missing.length === 1;
  return `${missing.join(', ')} ${one ? 'is' : 'are'} declared but not installed. `
    + `This window does not need ${one ? 'it' : 'them'}; run \`npm ci\` before builds or tests.`;
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
  LAUNCH_TOOLS,
  missingRuntimeDependencies,
  toolingProblem,
  stampPath,
  lockPath,
  writeLockStamp,
  dependencyProblem,
};
