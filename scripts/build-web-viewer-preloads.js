const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { rebuildWebViewerPreloads } = require('../src/runtime-build');

const root = path.join(__dirname, '..');
rebuildWebViewerPreloads({
  esbuild,
  fs,
  srcDir: path.join(root, 'src'),
  distDir: path.join(root, 'dist'),
});
