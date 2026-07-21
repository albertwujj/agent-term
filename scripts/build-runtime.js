#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { rebuildRuntimeBundles } = require('../src/runtime-build');

const repoRoot = path.resolve(__dirname, '..');
rebuildRuntimeBundles({
  esbuild,
  fs,
  srcDir: path.join(repoRoot, 'src'),
  distDir: path.join(repoRoot, 'dist'),
});
