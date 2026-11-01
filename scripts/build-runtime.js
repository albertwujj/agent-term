#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { rebuildRuntimeBundles } = require('../src/runtime-build');
const { nameElectronBundle } = require('../src/electron-app-name');

const repoRoot = path.resolve(__dirname, '..');
rebuildRuntimeBundles({
  esbuild,
  fs,
  srcDir: path.join(repoRoot, 'src'),
  distDir: path.join(repoRoot, 'dist'),
});

if (process.platform === 'darwin') {
  nameElectronBundle({ fs, electronDir: path.dirname(require.resolve('electron/package.json')) });
}
