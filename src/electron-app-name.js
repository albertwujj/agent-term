// Unpackaged Electron runs from node_modules/electron/dist/Electron.app. macOS
// names a process after the bundle folder it was launched through: that is the
// Dock's hover label and the Cmd-Tab name, fixed at launch (nothing set at
// runtime changes it, LaunchServices' display name included). The application
// menu's title comes from CFBundleName in the bundle's Info.plist instead. So
// the build writes the name into the plist and links a sibling AgentTerm.app to
// the bundle, and `npm run start` launches through that link. The bundle
// carries only a linker signature on its executable (no _CodeSignature seal),
// so both are safe to touch. Running on every build lets a pulled checkout pick
// the name up on its next start.
const path = require('path');

const APP_NAME = 'AgentTerm';
const BUNDLE = 'Electron.app';
const NAME_KEYS = ['CFBundleName', 'CFBundleDisplayName'];

function electronPlistPath(electronDir) {
  return path.join(electronDir, 'dist', BUNDLE, 'Contents', 'Info.plist');
}

function namedBundlePath(electronDir, name = APP_NAME) {
  return path.join(electronDir, 'dist', `${name}.app`);
}

function namedBundleExecPath(electronDir, name = APP_NAME) {
  return path.join(namedBundlePath(electronDir, name), 'Contents', 'MacOS', 'Electron');
}

function renamePlist(xml, name) {
  let out = xml;
  for (const key of NAME_KEYS) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!re.test(out)) throw new Error(`${key} missing from Electron's Info.plist`);
    out = out.replace(re, `$1${name}$2`);
  }
  return out;
}

// Returns true when the plist was rewritten, false when it already carried the name.
function applyElectronAppName({ fs, plistPath, name = APP_NAME }) {
  const before = fs.readFileSync(plistPath, 'utf8');
  const after = renamePlist(before, name);
  if (after === before) return false;
  fs.writeFileSync(plistPath, after);
  return true;
}

// Links dist/<name>.app to Electron.app (a relative link, next to it). Returns
// true when the link was made or repointed, false when it already pointed there.
function ensureNamedBundleLink({ fs, electronDir, name = APP_NAME }) {
  const link = namedBundlePath(electronDir, name);
  let existing = null;
  try {
    existing = fs.lstatSync(link);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink`);
    if (fs.readlinkSync(link) === BUNDLE) return false;
    fs.unlinkSync(link);
  }
  fs.symlinkSync(BUNDLE, link, 'dir');
  return true;
}

module.exports = {
  APP_NAME,
  electronPlistPath,
  namedBundlePath,
  namedBundleExecPath,
  renamePlist,
  applyElectronAppName,
  ensureNamedBundleLink,
};
