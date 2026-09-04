#!/usr/bin/env node

// Frozen Windows installer support. Before using or changing this path, read
// docs/dev/maintainer/windows-installer.md for the v0.1.15 recovery baseline and validation scope.

const path = require('path');
const { spawn } = require('child_process');
const {
  NSIS_PATH,
  NsisTargetOptions,
} = require('app-builder-lib/out/targets/nsis/nsisUtil');

async function buildLauncher() {
  NsisTargetOptions.resolve({});

  const nsisPath = await NSIS_PATH();
  const makensis = path.join(
    nsisPath,
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'Bin' : 'linux',
    process.platform === 'win32' ? 'makensis.exe' : 'makensis'
  );
  const repoRoot = path.resolve(__dirname, '..');

  await new Promise((resolve, reject) => {
    const child = spawn(makensis, ['-V2', 'scripts/installer/launcher.nsi'], {
      cwd: repoRoot,
      env: { ...process.env, NSISDIR: nsisPath },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`makensis terminated by signal ${signal}`));
        return;
      }

      reject(new Error(`makensis exited with code ${code}`));
    });
  });
}

buildLauncher().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
