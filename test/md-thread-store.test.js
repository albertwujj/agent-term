const assert = require('assert');
const path = require('path');
const { MD_STORE_DIR, mdStorePosixPath, uncFromPosix } = require('../src/md-thread-store');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

check('the store is a named file inside the document\'s .agent-threads folder', () => {
  assert.strictEqual(mdStorePosixPath('/docs/launch-plan.md'), '/docs/.agent-threads/launch-plan-comments.json');
  assert.strictEqual(mdStorePosixPath('/a/b/README.md'), '/a/b/.agent-threads/README-comments.json');
  assert.strictEqual(MD_STORE_DIR, '.agent-threads');
});

check('the basename is carried verbatim', () => {
  // No case folding and no character transform: the store is meant to be
  // recognisable as belonging to its document at a glance.
  assert.strictEqual(mdStorePosixPath('/x/My Notes.md'), '/x/.agent-threads/My Notes-comments.json');
  assert.strictEqual(mdStorePosixPath('/x/UPPER.MD'), '/x/.agent-threads/UPPER-comments.json');
  assert.strictEqual(mdStorePosixPath('/x/dot.ted.name.md'), '/x/.agent-threads/dot.ted.name-comments.json');
});

check('every markdown extension is replaced, and only at the end', () => {
  assert.strictEqual(mdStorePosixPath('/x/a.markdown'), '/x/.agent-threads/a-comments.json');
  assert.strictEqual(mdStorePosixPath('/x/a.mdown'), '/x/.agent-threads/a-comments.json');
  // "md" inside the name is not an extension.
  assert.strictEqual(mdStorePosixPath('/x/md-link-target.md'), '/x/.agent-threads/md-link-target-comments.json');
});

check('a document at the filesystem root still resolves', () => {
  assert.strictEqual(mdStorePosixPath('/README.md'), '/.agent-threads/README-comments.json');
});

// --- Windows / WSL -----------------------------------------------------------
//
// On Windows the app runs on the host while the documents and their stores live
// inside WSL, so main's fs calls cross that boundary. The store folder has to
// survive the crossing: the path must convert, and the host's path.dirname must
// still name the folder to create.

check('a store path converts to the WSL UNC form Windows can open', () => {
  assert.strictEqual(
    uncFromPosix('/home/y/docs/.agent-threads/launch-plan-comments.json', 'Ubuntu'),
    '\\\\wsl.localhost\\Ubuntu\\home\\y\\docs\\.agent-threads\\launch-plan-comments.json',
  );
});

check('the folder to create is the UNC parent, nesting and all', () => {
  const unc = uncFromPosix(mdStorePosixPath('/home/y/docs/launch-plan.md'), 'Ubuntu');
  assert.strictEqual(
    path.win32.dirname(unc),
    '\\\\wsl.localhost\\Ubuntu\\home\\y\\docs\\.agent-threads',
  );
});

check('the folder is exactly one level below a directory that already exists', () => {
  // This is what makes the recursive mkdir safe over UNC. The store folder's
  // parent is the document's own directory, which must exist for the document to
  // have been opened, so mkdir succeeds on its first attempt and never recurses
  // toward \\wsl.localhost or the distro share.
  const doc = '/home/y/docs/launch-plan.md';
  const storeDir = path.posix.dirname(mdStorePosixPath(doc));
  assert.strictEqual(storeDir, '/home/y/docs/' + MD_STORE_DIR);
  assert.strictEqual(path.posix.dirname(storeDir), path.posix.dirname(doc));

  const uncStoreDir = path.win32.dirname(uncFromPosix(mdStorePosixPath(doc), 'Ubuntu'));
  assert.strictEqual(
    path.win32.dirname(uncStoreDir),
    path.win32.dirname(uncFromPosix(doc, 'Ubuntu')),
  );
});

check('a UNC share root is a fixed point, so an upward walk cannot pass it', () => {
  // Belt and braces on the above: even if a parent were missing, the traversal
  // terminates at the share instead of trying to create it.
  const share = '\\\\wsl.localhost\\Ubuntu';
  assert.strictEqual(path.win32.dirname(share), share);
});

check('a distro name with a dot or dash survives', () => {
  assert.strictEqual(
    path.win32.dirname(uncFromPosix(mdStorePosixPath('/w/a.md'), 'Ubuntu-22.04')),
    '\\\\wsl.localhost\\Ubuntu-22.04\\w\\.agent-threads',
  );
});

check('on mac and linux the posix path is what fs opens', () => {
  // fsPathFromPosix returns the posix path unchanged off Windows; the folder to
  // create is its posix parent.
  const store = mdStorePosixPath('/Users/y/agent-term/README.md');
  assert.strictEqual(path.posix.dirname(store), '/Users/y/agent-term/.agent-threads');
});

check('the shared -comments.json guard still accepts the new name', () => {
  // main.js validCommentsPath: only ever touch a *-comments.json path.
  const validCommentsPath = (p) => /-comments\.json$/i.test(p);
  assert.strictEqual(validCommentsPath(mdStorePosixPath('/a/b.md')), true);
});

console.log(`\n${passed} passed, 0 failed`);
console.log('md-thread-store tests passed');
