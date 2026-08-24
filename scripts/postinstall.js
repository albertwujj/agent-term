const { spawnSync } = require('child_process');

function runPostinstall({
  spawn = spawnSync,
  nodePath = process.execPath,
  resolve = require.resolve,
  load = require,
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
