#!/usr/bin/env node

// `npm run start`: launch this checkout in unpackaged Electron. On macOS the
// launch goes through the AgentTerm.app link the build made next to
// Electron.app, because the Dock and Cmd-Tab name a process after the bundle
// folder it was launched through. Elsewhere the electron package's own binary
// is used directly. Windows from WSL has its own launcher (start:wsl).
const { spawn } = require('child_process');
const path = require('path');
const { namedBundleExecPath } = require('../src/electron-app-name');

const repoRoot = path.resolve(__dirname, '..');
const execPath = process.platform === 'darwin'
  ? namedBundleExecPath(path.dirname(require.resolve('electron/package.json')))
  : require('electron');

const child = spawn(execPath, [repoRoot, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
