// node-pty ships its macOS/Linux `spawn-helper` prebuilt binary in the npm
// tarball WITHOUT the execute bit (stored -rw-r--r--). When node-pty resolves
// to a prebuild instead of compiling from source, nothing restores +x, so the
// pty fails at runtime with `posix_spawnp failed`. This runs on postinstall to
// chmod any spawn-helper prebuild back to executable. No-op on Windows.
const fs = require('fs');
const path = require('path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

try {
  if (!fs.existsSync(prebuilds)) process.exit(0);
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`[fix-pty-perms] chmod +x ${path.relative(process.cwd(), helper)}`);
    }
  }
} catch (err) {
  // Never fail the install over this; the app can still be chmod'd by hand.
  console.warn(`[fix-pty-perms] skipped: ${err.message}`);
}
