const path = require('path');

// These are the only generated JavaScript files loaded at runtime. Keep their
// build definitions together so `npm run build` and an in-place dev relaunch
// cannot disagree about which code needs refreshing.
function runtimeBundleSpecs(srcDir, distDir) {
  return [
    {
      name: 'renderer',
      options: {
        entryPoints: [path.join(srcDir, 'renderer.js')],
        bundle: true,
        outfile: path.join(distDir, 'renderer.js'),
        platform: 'browser',
        format: 'iife',
      },
    },
    {
      name: 'remote web-viewer preload',
      options: {
        entryPoints: [path.join(srcDir, 'web-viewer-remote-preload.js')],
        bundle: true,
        outfile: path.join(distDir, 'web-viewer-remote-preload.js'),
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
      },
    },
    {
      name: 'review web-viewer preload',
      options: {
        entryPoints: [path.join(srcDir, 'web-viewer-preload.js')],
        bundle: true,
        outfile: path.join(distDir, 'web-viewer-preload.js'),
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
      },
    },
  ];
}

function rebuildBundleSpecs({ esbuild, fs, distDir, specs }) {
  fs.mkdirSync(distDir, { recursive: true });

  // Remove every prior runtime artifact before compiling either one. If a
  // build fails, no later launch can accidentally fall through to old code.
  for (const spec of specs) fs.rmSync(spec.options.outfile, { force: true });
  for (const spec of specs) esbuild.buildSync(spec.options);
  return specs.map((spec) => spec.options.outfile);
}

function rebuildRuntimeBundles({ esbuild, fs, srcDir, distDir }) {
  return rebuildBundleSpecs({
    esbuild,
    fs,
    distDir,
    specs: runtimeBundleSpecs(srcDir, distDir),
  });
}

function rebuildWebViewerPreloads({ esbuild, fs, srcDir, distDir }) {
  return rebuildBundleSpecs({
    esbuild,
    fs,
    distDir,
    specs: runtimeBundleSpecs(srcDir, distDir).filter((spec) =>
      spec.name.includes('web-viewer preload')),
  });
}

module.exports = { runtimeBundleSpecs, rebuildRuntimeBundles, rebuildWebViewerPreloads };
