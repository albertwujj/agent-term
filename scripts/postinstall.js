const { spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { writeLockStamp } = require('../src/dep-freshness');

const repoRoot = path.join(__dirname, '..');

function runPostinstall({
  spawn = spawnSync,
  nodePath = process.execPath,
  resolve = require.resolve,
  load = require,
  stamp = writeLockStamp,
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
