// wsl-spin-watch.js — notice when this window's own wsl.exe is spinning, and
// decide what to do about it. main.js owns the IO (the PowerShell probe, the
// Claude session lookup through the POSIX seam, the kill, the new shell); this
// owns reading the numbers and the decision.
//
// WSL 2.5.7 leaks: when the Linux side of a Windows .exe is killed while that
// .exe is still launching, the wsl.exe of the session that launched it keeps
// the call's three relay threads, and one of them spins in kernel mode at a full
// core until that wsl.exe exits. Claude Code sets it off on a loaded machine:
// every 30 minutes it reads its managed policy with reg.exe under a 5 s timeout,
// and a launch that runs past the timeout is killed mid-launch. Each leak loads
// the machine further, which makes the next timeout likelier. Nothing inside WSL
// shows the CPU, and only the wsl.exe exiting stops it, which ends the window's shell.
//
// A healthy window's wsl.exe only relays the terminal's bytes and stays near zero;
// a leaked one burns a core per leak whether or not anything is printed. Use
// above SPIN_CORES for SPIN_SAMPLES probes in a row is therefore the leak.

'use strict';

const SPIN_PROBE_MS = 5 * 60_000;
const SPIN_CORES = 0.5;
const SPIN_SAMPLES = 2;
// How long the agent must have been quiet, and the user away from the
// keyboard, before the shell is restarted under them.
const HEAL_QUIET_MS = 2 * 60_000;

// PowerShell printing one line per wsl.exe among `pid` and its children:
// "<pid> <parent> <threads> <cpu in 100 ns units>". The Windows wsl.exe is a
// stub that starts the WSL package's own wsl.exe as its child, and that child
// is the one holding the session's relays.
function spinProbeScript(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`not a pid: ${pid}`);
  return `Get-CimInstance Win32_Process -Filter "Name='wsl.exe' AND (ProcessId=${id} OR ParentProcessId=${id})" | `
    + 'ForEach-Object { "{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $_.ThreadCount, '
    + '($_.KernelModeTime + $_.UserModeTime) }';
}

// The session's wsl.exe in the probe's output: the pty's wsl.exe child where
// the stub started one, else the pty's own process. null when neither is
// listed (the shell already exited, or the probe failed).
function sessionProcess(stdout, ptyPid) {
  const rows = String(stdout || '').split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 4 && f.every(Number.isFinite))
    .map(([pid, parent, threads, cpu]) => ({ pid, parent, threads, cpu }));
  return rows.find((r) => r.parent === ptyPid && r.pid !== ptyPid)
    || rows.find((r) => r.pid === ptyPid)
    || null;
}

// Reads one window's successive probes. observe() reports the cores the
// session's wsl.exe used since the previous probe, and whether it has stayed
// over the line SPIN_SAMPLES probes in a row. A different pid starts over: the
// window has a new shell.
function createSpinWatch({ cores = SPIN_CORES, samples = SPIN_SAMPLES } = {}) {
  let last = null;
  let over = 0;
  function observe(proc, atMs) {
    if (!proc) {
      last = null;
      over = 0;
      return { spinning: false, cores: null };
    }
    let used = null;
    if (last && last.pid === proc.pid && atMs > last.atMs) {
      used = (proc.cpu - last.cpu) / 1e4 / (atMs - last.atMs); // 100 ns units → CPU ms per ms
      over = used >= cores ? over + 1 : 0;
    } else {
      over = 0;
    }
    last = { pid: proc.pid, cpu: proc.cpu, atMs };
    return { spinning: over >= samples, cores: used, threads: proc.threads, pid: proc.pid };
  }
  return { observe };
}

// POSIX: Claude's own record of the shell's child process
// (<config dir>/sessions/<pid>.json), printed as is; exit 1 when the shell's
// children include no Claude process.
function claudeSessionScript(pidFile, shellEscape) {
  return `pid=$(cat -- ${shellEscape(pidFile)}) && dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions" && `
    + 'for c in $(cat "/proc/$pid/task/$pid/children" 2>/dev/null); do '
    + '[ -f "$dir/$c.json" ] && { cat -- "$dir/$c.json"; exit 0; }; done; exit 1';
}

// The fields a resume needs from that record, or null. The JSON is the last
// line: the probe shell's profile can print ahead of it.
function parseClaudeSession(stdout) {
  const line = String(stdout || '').trim().split('\n').pop();
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || typeof rec.sessionId !== 'string' || !/^[0-9a-f-]{8,}$/i.test(rec.sessionId)) return null;
  return {
    sessionId: rec.sessionId,
    cwd: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : null,
    status: typeof rec.status === 'string' ? rec.status : null,
  };
}

// What to do about a spinning wsl.exe:
//   heal   — end its wsl.exe and resume the Claude session in a new shell
//   wait   — Claude is working, the user typed recently, or something typed is
//            still unsent in the prompt: ask again at the next probe
//   notice — no Claude session to resume (another CLI, a bare shell): say so
//            and leave the shell to the user
function healPlan({ session, quietMs, composing }) {
  if (!session) return 'notice';
  if (composing || quietMs < HEAL_QUIET_MS) return 'wait';
  if (session.status && session.status !== 'idle') return 'wait';
  return 'heal';
}

// The line the new shell runs: back to the directory Claude keeps the session
// under, then resume it.
function resumeCommand(session, shellEscape) {
  const resume = `claude --resume ${shellEscape(session.sessionId)}`;
  return session.cwd ? `cd ${shellEscape(session.cwd)} && ${resume}` : resume;
}

module.exports = {
  SPIN_PROBE_MS,
  HEAL_QUIET_MS,
  spinProbeScript,
  sessionProcess,
  createSpinWatch,
  claudeSessionScript,
  parseClaudeSession,
  healPlan,
  resumeCommand,
};
