// Atomic file replacement, shared by every registry and store writer.
//
// Write a sibling temp file, then rename it over the target: a reader sees
// the old content or the new, never a partial write. The temp name carries
// the writer's pid and a per-process counter, so two processes replacing the
// same file at the same moment never share a temp path. With one shared name
// the second writer's rename fails with ENOENT once the first has moved the
// file away (two windows heartbeating one active record did exactly that).

const fs = require('fs');

let seq = 0;

function tempPath(file) {
  seq += 1;
  return `${file}.${process.pid}.${seq}.tmp`;
}

function writeFileAtomicSync(file, data, options) {
  const tmp = tempPath(file);
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

async function writeFileAtomic(file, data, options) {
  const tmp = tempPath(file);
  try {
    await fs.promises.writeFile(tmp, data, options);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch {}
    throw err;
  }
}

module.exports = { writeFileAtomicSync, writeFileAtomic };
