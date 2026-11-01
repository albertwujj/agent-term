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

// `npm ci` has just removed the AgentTerm.app link and the name in Electron's
// plist. The next start would make them again, but a window already running needs
// the link now: one coming back from hiding before then would have no Dock tile.
function nameInstalledBundle({ resolve, fsApi }) {
  if (process.platform !== 'darwin') return;
  const { nameElectronBundle } = require(path.join(repoRoot, 'src', 'electron-app-name.js'));
  nameElectronBundle({ fs: fsApi, electronDir: path.dirname(resolve('electron/package.json')) });
}

function runPostinstall({
  spawn = spawnSync,
  nodePath = process.execPath,
  resolve = require.resolve,
  load = require,
  stamp = stampInstalledTree,
  nameBundle = nameInstalledBundle,
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

  // A failure here must not fail the install: the next start makes them again,
  // and says why if it cannot.
  try {
    nameBundle({ resolve, fsApi });
  } catch (err) {
    console.warn(`[postinstall] AgentTerm bundle name skipped: ${err.message}`);
  }

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
