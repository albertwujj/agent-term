#!/usr/bin/env node

// `npm run start`: launch this checkout in unpackaged Electron. Inside WSL the
// UI belongs on Windows, so the launch hands over to the Windows launcher,
// whose Electron builds the runtime bundles itself; `npm run start:linux`
// (--linux) keeps it here instead, in Linux Electron through WSLg. On macOS the
// launch goes through the AgentTerm.app link the build made next to
// Electron.app, because the Dock and Cmd-Tab name a process after the bundle
// folder it was launched through. Elsewhere the electron package's own binary
// is used directly.
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const linux = args[0] === '--linux';
if (linux) args.shift();

function exitWith(child) {
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

// WSL sets WSL_DISTRO_NAME in each session it starts. Its kernel names itself
// Microsoft even where that variable was lost (sudo, an ssh login), and there
// the Windows launcher says what is missing rather than a Linux window opening.
if (!linux && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()))) {
  exitWith(spawn('bash', [path.join(__dirname, 'start-windows-from-wsl.sh')], { stdio: 'inherit' }));
  return;
}

const build = spawnSync(process.execPath, [path.join(__dirname, 'build-runtime.js')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status === null ? 1 : build.status);

const { namedBundleExecPath } = require('../src/electron-app-name');
const { sourceLaunchEnv } = require('../src/source-start-cwd');

const execPath = process.platform === 'darwin'
  ? namedBundleExecPath(path.dirname(require.resolve('electron/package.json')))
  : require('electron');

// The launch directory is npm's, not one inherited from the AgentTerm window
// this command may have been typed in (sourceLaunchEnv).
exitWith(spawn(execPath, [repoRoot, ...args], {
  stdio: 'inherit',
  env: sourceLaunchEnv(),
}));
