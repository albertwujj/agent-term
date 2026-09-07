// Every package the source loads is declared in package.json.
//
// This is the half of the dependency question a check can answer ahead of time:
// a clean `npm ci` must produce a tree that can run. A package that is required
// but undeclared works on a machine where something else happened to install it
// and fails on a fresh clone, which is the failure a stranger meets first. What
// no test can answer is whether the tree on the machine being launched matches
// this checkout — that one belongs to the startup guard in dep-freshness.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

let testsPassed = 0, testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src', 'scripts', 'test'];

// Two files the scan skips, each for its own reason.
//
// build-launcher.js reaches into `app-builder-lib/out/…`, an internal path of
// electron-builder's own tree, and belongs to the frozen Windows installer
// pipeline (docs/dev/maintainer/windows-installer.md). Declaring a transitive
// package at top level to satisfy an unsupported script would pin a version
// that has to match electron-builder's anyway.
//
// This file quotes specifiers as examples, and a test that fails on its own
// prose is worse than one that skips it.
const SKIPPED = new Set(['scripts/build-launcher.js', 'test/declared-deps.test.js']);

// `electron` is the runtime itself in a main or preload process, and a builtin
// there rather than a package. It is declared anyway, so this exemption only
// matters if that ever stops being true.
const PROVIDED = new Set(['electron']);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      sourceFiles(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      if (!SKIPPED.has(path.relative(ROOT, full))) out.push(full);
    }
  }
  return out;
}

// Static specifiers only: require('x'), require.resolve('x'), import … from 'x'.
// A computed specifier cannot be checked and is not written here.
// The import forms are anchored to the start of a line, where a real statement
// lives. Unanchored, the word `import` inside a quoted string starts matching
// the rest of the file, and this repo's parser tests are full of sample code.
const SPECIFIER = new RegExp([
  /require(?:\.resolve)?\(\s*['"]([^'"]+)['"]/,               // require('x')
  /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/, // import … from 'x'
  /^\s*import\s*['"]([^'"]+)['"]/,                             // import 'x'
].map((r) => r.source).join('|'), 'gm');

function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return name;
}

function requiredPackages() {
  const found = new Map(); // package -> the first file that loads it
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(SPECIFIER)) {
        const name = packageOf(match[1] || match[2] || match[3]);
        if (name && !found.has(name)) found.set(name, path.relative(ROOT, file));
      }
    }
  }
  return found;
}

console.log('declared-deps');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(manifest.dependencies || {}),
  ...Object.keys(manifest.devDependencies || {}),
  ...Object.keys(manifest.optionalDependencies || {}),
]);

test('every package the source loads is declared in package.json', () => {
  const undeclared = [];
  for (const [name, file] of requiredPackages()) {
    if (declared.has(name) || PROVIDED.has(name)) continue;
    undeclared.push(`${name} (${file})`);
  }
  assert.deepStrictEqual(undeclared, [], 'a fresh npm ci would not install these');
});

test('every declared runtime dependency is actually loaded somewhere', () => {
  // The other direction, for `dependencies` only: devDependencies are tools
  // that scripts invoke by name rather than requiring. A runtime package
  // nobody loads is either dead weight or a require that got renamed.
  const loaded = requiredPackages();
  const unused = Object.keys(manifest.dependencies || {}).filter((name) => !loaded.has(name));
  assert.deepStrictEqual(unused, [], 'declared but never required');
});

test('the scan sees the packages this project is built on', () => {
  // Guards the regex itself: a specifier pattern that stopped matching would
  // make both tests above pass by finding nothing at all.
  const loaded = requiredPackages();
  // playwright-core proves the ESM import form is seen, the rest the require.
  for (const name of ['node-pty', 'markdown-it', '@xterm/xterm', 'esbuild', 'playwright-core']) {
    assert.ok(loaded.has(name), `expected the scan to find ${name}`);
  }
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
