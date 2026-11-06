// The CLI's own id for the conversation a session runs, so a pick in the
// picker resumes that conversation by id instead of sending /resume and
// leaving the user to find it in the CLI's resume dialog (resume-hint.js).
// Cursor Agent only, for now: `agent --resume <chat id>`.
//
// Where the id comes from. Cursor keeps each chat in
// <config dir>/chats/<md5 of the workspace path>/<chat id>/store.db, an
// SQLite file the running agent holds open for as long as that chat is the
// one on screen. An in-CLI /resume moves the handle to the chat it opened,
// so the file held open names the chat the session is running right now.
// Cursor's other surfaces were weighed and left: the per-process debug log
// in the temp dir names the chat too, but it is an internal log in a format
// nobody promises; the "To resume this session" line comes only on exit,
// and a window that closes never shows it. A chat with no message yet has
// no store.db, and there is nothing to resume then either.
//
// Where it must resume from. `agent --resume <id>` looks the chat up only
// under the md5 of its working directory, and an id it cannot find there
// opens as a new, empty chat under that id rather than failing. So the
// directory is recorded with the id, and only one whose md5 names the
// chat's bucket: the chat's own meta.json cwd, else the agent's cwd. If
// neither matches (an old chat without a cwd, opened from another workspace,
// or Cursor changing its scheme), the chat is recorded as unknown and the
// resume goes through the dialog, as for every other CLI.
//
// When main asks: a few seconds after each prompt the capture logs in a
// Cursor session, when that prompt has reached a chat (main.js
// scheduleConversationProbe). The answer is logged as a `conversation` event
// when it changes (sessions-log.js), and the picker's resume reads it back.
//
// The probe and the reading are separate so the reading can be tested on
// real output; the hash is passed in, so this module stays free of Node
// builtins and the renderer can import resumeLaunch.

'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_RE = /\/chats\/([0-9a-f]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/store\.db$/i;

// POSIX: one line per chat store held open by a descendant of the shell,
// "chat<TAB><store path><TAB><that process's cwd><TAB><the chat's meta.json
// on one line>". `pidExpr` is shell text that yields the shell's pid (a
// number, or a $(cat …) of the pid file). Linux and WSL read /proc; macOS
// has none and asks lsof. The platform is settled once: the listing
// includes the probe's own short-lived ps and awk, gone by their turn, and
// lsof on a pid that has exited takes seconds on Linux. The descendants
// come from one ps listing, which both platforms print the same way.
function cursorChatScript(pidExpr) {
  return `pid=${pidExpr} && `
    + 'if [ -d /proc/self/fd ]; then proc=1; else proc=; fi; '
    + 'for c in $(ps -e -o pid= -o ppid= | awk -v root="$pid" '
    + "'{ up[$1] = $2 } END { for (p in up) { q = p; n = 0; "
    + 'while (q in up && q != root && n++ < 64) q = up[q]; '
    + "if (q == root && p != root) print p } }'); do "
    + 'if [ -n "$proc" ]; then '
    + "files=$(ls -l \"/proc/$c/fd\" 2>/dev/null | sed -n 's/.* -> //p'); "
    + 'cwd=$(readlink "/proc/$c/cwd" 2>/dev/null); '
    + 'else '
    + "files=$(lsof -p \"$c\" -Fn 2>/dev/null | sed -n 's/^n//p'); "
    + "cwd=$(lsof -a -p \"$c\" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); "
    + 'fi; '
    + "printf '%s\\n' \"$files\" | grep '/chats/[0-9a-fA-F]*/[0-9a-fA-F-]*/store\\.db$' | sort -u | "
    + 'while IFS= read -r s; do '
    + "printf 'chat\\t%s\\t%s\\t' \"$s\" \"$cwd\"; "
    + 'tr -d \'\\n\\t\' < "${s%/store.db}/meta.json" 2>/dev/null; echo; '
    + 'done; '
    + 'done';
}

// The probe's answer:
//   null                          no chat store is held: nothing reached a
//                                 chat yet, or the agent has exited. Keep
//                                 what was recorded.
//   { id, dir }                   the chat on screen, and the directory to
//                                 resume it from
//   { id: null }                  a chat is held but cannot be resumed by id
//                                 (two at once, or no directory that names
//                                 its bucket): what was recorded no longer
//                                 holds, so it is cleared
// `md5` maps a string to its lowercase hex digest. Lines other than the
// probe's (a login shell's profile noise) are ignored.
function readCursorChat(stdout, md5) {
  const chats = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const [tag, store, cwd, meta] = line.replace(/\r$/, '').split('\t');
    if (tag !== 'chat' || !store) continue;
    const m = STORE_RE.exec(store);
    if (!m) continue;
    const id = m[2].toLowerCase();
    if (chats.has(id)) continue;
    let metaCwd = null;
    try {
      const parsed = JSON.parse(meta || '');
      if (parsed && typeof parsed.cwd === 'string' && parsed.cwd) metaCwd = parsed.cwd;
    } catch {}
    chats.set(id, { id, bucket: m[1].toLowerCase(), candidates: [metaCwd, cwd || null] });
  }
  if (chats.size === 0) return null;
  if (chats.size > 1) return { id: null };
  const chat = chats.values().next().value;
  const dir = chat.candidates.find((d) => d && md5(d) === chat.bucket);
  return dir ? { id: chat.id, dir } : { id: null };
}

// How a picked session resumes by id, or null when it goes through the
// CLI's dialog. One rule for main (which launches it) and the renderer
// (which then shows no resume band).
//   cwd   the directory to start the CLI in
//   args  the arguments after the CLI's name
function resumeLaunch(session) {
  if (!session || session.cli !== 'agent') return null;
  const c = session.conversation;
  if (!c || typeof c.id !== 'string' || !UUID_RE.test(c.id)) return null;
  if (typeof c.dir !== 'string' || !c.dir.startsWith('/')) return null;
  return { cwd: c.dir, args: ['--resume', c.id] };
}

// Whether two recorded conversations are the same; a cleared one ({ id:
// null }) is the same as none.
function sameConversation(a, b) {
  const key = (c) => (c && c.id ? `${c.id}\n${c.dir}` : '');
  return key(a) === key(b);
}

module.exports = {
  cursorChatScript,
  readCursorChat,
  resumeLaunch,
  sameConversation,
};
