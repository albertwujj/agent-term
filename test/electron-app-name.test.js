const assert = require('assert');
const path = require('path');
const {
  APP_NAME, electronPlistPath, namedBundleExecPath, renamePlist, applyElectronAppName,
  ensureNamedBundleLink,
} = require('../src/electron-app-name');

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

const PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>CFBundleDisplayName</key>',
  '\t<string>Electron</string>',
  '\t<key>CFBundleExecutable</key>',
  '\t<string>Electron</string>',
  '\t<key>CFBundleIdentifier</key>',
  '\t<string>com.github.Electron</string>',
  '\t<key>CFBundleName</key>',
  '\t<string>Electron</string>',
  '</dict>',
  '</plist>',
].join('\n');

const electronDir = path.join('/repo', 'node_modules', 'electron');
const link = path.join(electronDir, 'dist', 'AgentTerm.app');

// A fake fs holding at most one entry at the link path.
function linkFs(entry) {
  const events = [];
  return {
    events,
    lstatSync(p) {
      assert.strictEqual(p, link);
      if (!entry) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
      return { isSymbolicLink: () => entry.type === 'symlink' };
    },
    readlinkSync(p) { assert.strictEqual(p, link); return entry.target; },
    unlinkSync(p) { events.push(['unlink', p]); },
    symlinkSync(target, p, kind) { events.push(['symlink', target, p, kind]); },
  };
}

console.log('electron-app-name');

test('renames only the two display keys, leaving executable and identifier alone', () => {
  const out = renamePlist(PLIST, 'AgentTerm');
  assert.match(out, /<key>CFBundleDisplayName<\/key>\n\t<string>AgentTerm<\/string>/);
  assert.match(out, /<key>CFBundleName<\/key>\n\t<string>AgentTerm<\/string>/);
  assert.match(out, /<key>CFBundleExecutable<\/key>\n\t<string>Electron<\/string>/);
  assert.match(out, /<key>CFBundleIdentifier<\/key>\n\t<string>com.github.Electron<\/string>/);
});

test('fails clearly when a name key is missing', () => {
  const noName = PLIST.replace('\t<key>CFBundleName</key>\n\t<string>Electron</string>\n', '');
  assert.throws(() => renamePlist(noName, 'AgentTerm'), /CFBundleName missing/);
});

test('writes the plist once, then leaves it untouched', () => {
  const writes = [];
  let content = PLIST;
  const fakeFs = {
    readFileSync: () => content,
    writeFileSync: (_file, data) => { writes.push(data); content = data; },
  };
  assert.strictEqual(applyElectronAppName({ fs: fakeFs, plistPath: 'Info.plist' }), true);
  assert.strictEqual(writes.length, 1);
  assert.match(writes[0], new RegExp(`<key>CFBundleName</key>\\n\\t<string>${APP_NAME}</string>`));
  assert.strictEqual(applyElectronAppName({ fs: fakeFs, plistPath: 'Info.plist' }), false);
  assert.strictEqual(writes.length, 1);
});

test('locates the plist and the named launch path inside the electron package', () => {
  assert.strictEqual(
    electronPlistPath(electronDir),
    path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'Info.plist'),
  );
  assert.strictEqual(
    namedBundleExecPath(electronDir),
    path.join(link, 'Contents', 'MacOS', 'Electron'),
  );
});

test('makes the AgentTerm.app link next to Electron.app when it is missing', () => {
  const fakeFs = linkFs(null);
  assert.strictEqual(ensureNamedBundleLink({ fs: fakeFs, electronDir }), true);
  assert.deepStrictEqual(fakeFs.events, [['symlink', 'Electron.app', link, 'dir']]);
});

test('leaves a link that already points at Electron.app alone', () => {
  const fakeFs = linkFs({ type: 'symlink', target: 'Electron.app' });
  assert.strictEqual(ensureNamedBundleLink({ fs: fakeFs, electronDir }), false);
  assert.deepStrictEqual(fakeFs.events, []);
});

test('repoints a link that points elsewhere', () => {
  const fakeFs = linkFs({ type: 'symlink', target: 'Other.app' });
  assert.strictEqual(ensureNamedBundleLink({ fs: fakeFs, electronDir }), true);
  assert.deepStrictEqual(fakeFs.events, [
    ['unlink', link],
    ['symlink', 'Electron.app', link, 'dir'],
  ]);
});

test('refuses to replace a real directory at the link path', () => {
  const fakeFs = linkFs({ type: 'dir' });
  assert.throws(() => ensureNamedBundleLink({ fs: fakeFs, electronDir }), /not a symlink/);
  assert.deepStrictEqual(fakeFs.events, []);
});

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
