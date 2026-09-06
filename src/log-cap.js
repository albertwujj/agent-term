// Size caps for the two log files under <userData>/logs. pruneDiskLogs deletes
// what is older than a week, which bounds accumulation but not a single file:
// a window whose output loops writes gigabytes into one file inside a day, and
// the age sweep never looks at it. These two functions bound each file, and
// they differ because we own one descriptor and not the other.
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const OLD_SUFFIX = '.old';

// main-<pid>.log: we open, write and close it ourselves, so this is ordinary
// rotation. The caller closes its handle, calls this, and reopens; one previous
// generation survives as .old, and the sweep ages both out together.
function rotateIfLarge({ fs, file, bytes, maxBytes = MAX_LOG_BYTES }) {
  if (!(bytes > maxBytes)) return false;
  fs.renameSync(file, file + OLD_SUFFIX);
  return true;
}

// console-<...>.log: the child's stdout and stderr, opened by the parent before
// exec. Renaming it would move the directory entry and leave the descriptor
// writing into the renamed inode, with nothing recreating the path the pointer
// line names — and rebinding fd 1 from inside Node needs a dup2 we do not have.
// So trim in place: keep the most recent bytes, drop the rest, and let the
// descriptor carry on. It is O_APPEND, so the next write lands after what we
// leave behind, at the same path, with no hole.
//
// Bytes written between the read and the rewrite are lost. The window is a
// couple of milliseconds, and this only ever runs on a file that has already
// gone past four megabytes nobody has read.
function trimToTail({ fs, file, maxBytes = MAX_LOG_BYTES, tailBytes = TAIL_BYTES, now = Date.now }) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size <= maxBytes) return null;

  const start = Math.max(0, size - tailBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, length, start); }
  finally { try { fs.closeSync(fd); } catch {} }

  // Reading from an offset lands mid-line. Start after the first newline so the
  // file never opens on half a message; a slice with no newline at all is one
  // enormous line, and none of it is worth keeping.
  let tail = buf;
  if (start > 0) {
    const nl = buf.indexOf(0x0a);
    tail = nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
  }

  const stamp = new Date(now()).toISOString();
  const marker = Buffer.from(
    `[agent-term ${stamp}] this file passed ${maxBytes} bytes; `
    + `${size - tail.length} bytes of older output were dropped\n`);
  // 'w' truncates and writes in one step, which is the trim itself.
  fs.writeFileSync(file, Buffer.concat([marker, tail]));
  return { dropped: size - tail.length, kept: tail.length };
}

module.exports = { MAX_LOG_BYTES, TAIL_BYTES, OLD_SUFFIX, rotateIfLarge, trimToTail };
