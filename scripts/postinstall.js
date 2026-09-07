const { spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

// The WSL development launcher installs its Windows dependency tree from a
// runner directory holding this script and fix-pty-perms.js, and nothing else:
// src/ arrives later, in the per-process snapshot the app stages at launch,
// and no start ever reads a stamp written in the runner tree. So the stamp
// writer is asked for where it exists rather than at load time, where a
// require for a file that tree has no use for would fail the whole install.
function stampInstalledTree(options) {
  const source = path.join(repoRoot, 'src', 'dep-freshness.js');
  if (!fs.existsSync(source)) return null;
  return require(source).writeLockStamp(options);
}

function runPostinstall({
  spawn = spawnSync,
  nodePath = process.execPath,
  resolve = require.resolve,
  load = require,
  stamp = stampInstalledTree,
  fsApi = fs,
  cryptoApi = crypto,
  root = repoRoot,
} = {}) {
  const electronInstaller = resolve('electron/install.js');
  const result = spawn(nodePath, [electronInstaller], {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron installation failed with exit code ${result.status}`);
  }

  load('./fix-pty-perms');

  // Stamp the tree with the lockfile it was installed from, so a later start
  // can tell that node_modules and package-lock.json have drifted apart. A
  // failure here must not fail the install: the check treats a missing stamp
  // as "cannot judge" and stays quiet.
  try {
    stamp({ fs: fsApi, crypto: cryptoApi, root });
  } catch (err) {
    console.warn(`[postinstall] dependency stamp skipped: ${err.message}`);
  }
}

if (require.main === module) {
  try {
    runPostinstall();
  } catch (err) {
    console.error(`[postinstall] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runPostinstall };
