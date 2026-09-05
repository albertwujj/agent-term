'use strict';

const WSL_COMMAND_HELPER = String.raw`set +e
umask 077

# The bootstrap materializes this script in a temp file (see helperBootstrap):
# bash must read the SCRIPT from a file so that stdin stays free for the REQUEST
# stream below. Drop the file now that bash holds it open. $0 is the shell's own
# name, not a path, when the script is passed inline instead, so only an
# absolute path is removed.
case "$0" in /*) rm -f -- "$0" ;; esac

while IFS=$'\t' read -r request_id duration command_b64; do
  case "$request_id" in
    ''|*[!0-9]*) continue ;;
  esac

  printf '%s\tstart\n' "$request_id"

  request_dir=$(mktemp -d "/tmp/agent-term-rpc.XXXXXX") || exit 70
  command_file="$request_dir/command"
  stdout_file="$request_dir/stdout"
  stderr_file="$request_dir/stderr"

  if ! printf '%s' "$command_b64" | base64 -d >"$command_file" 2>"$stderr_file"; then
    status=65
    : >"$stdout_file"
  else
    if [ "$duration" != "0" ] && command -v timeout >/dev/null 2>&1; then
      timeout --signal=KILL "$duration" bash "$command_file" </dev/null >"$stdout_file" 2>"$stderr_file"
      status=$?
    else
      bash "$command_file" </dev/null >"$stdout_file" 2>"$stderr_file"
      status=$?
    fi
  fi

  stdout_b64=$(base64 <"$stdout_file" | tr -d '\n')
  stderr_b64=$(base64 <"$stderr_file" | tr -d '\n')
  printf '%s\t%s\t%s\t%s\n' "$request_id" "$status" "$stdout_b64" "$stderr_b64"
  rm -rf -- "$request_dir"
done
`;

// How the helper is launched. The helper reads its REQUESTS from stdin, so bash
// must not read its SCRIPT from there too: `… | base64 -d | bash` hands bash the
// decode pipe as stdin, the loop's first read hits EOF, and the helper exits 0
// having served nothing. Writing the script to a file and exec-ing it keeps
// stdin as the protocol channel, and `exec` keeps the helper as the runner's
// direct child so child.kill() reaches it rather than a wrapper.
//
// The payload stays an opaque base64 token because wsl.exe re-splits a complex
// `-lc <script>` by its own rules and mangles it silently (exit 0, no stderr).
function helperBootstrap(script = WSL_COMMAND_HELPER) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `f=$(mktemp) && echo ${b64} | base64 -d > "$f" && exec bash "$f"`;
}

function transportBackoffMs(failureCount) {
  return Math.min(60_000 * (2 ** Math.max(0, failureCount - 1)), 300_000);
}

class WslCommandRunner {
  constructor({
    spawn,
    command,
    args = [],
    spawnOptions = {},
    onDiagnostic = () => {},
    now = Date.now,
  }) {
    this.spawn = spawn;
    this.command = command;
    this.args = args;
    this.spawnOptions = spawnOptions;
    this.onDiagnostic = onDiagnostic;
    this.now = now;

    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pending = new Map();
    this.nextRequestId = 1;
    this.failureCount = 0;
    this.retryAt = 0;
    this.closed = false;
  }

  run(shellCommand, options = {}) {
    if (this.closed) {
      return Promise.resolve(this._errorResult('WSL helper is closed'));
    }

    const child = this._ensureChild();
    if (!child) {
      const retryMs = Math.max(0, this.retryAt - this.now());
      return Promise.resolve(this._errorResult(
        `WSL helper unavailable; retry in ${Math.ceil(retryMs / 1000)}s`,
      ));
    }

    const requestId = String(this.nextRequestId++);
    const timeoutMs = Number.isFinite(options.timeout) && options.timeout > 0
      ? Math.floor(options.timeout)
      : 0;
    const duration = timeoutMs > 0 ? `${(timeoutMs / 1000).toFixed(3)}s` : '0';
    const commandB64 = Buffer.from(String(shellCommand), 'utf8').toString('base64');
    const maxBuffer = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0
      ? options.maxBuffer
      : 16 * 1024 * 1024;

    return new Promise((resolve) => {
      const pending = { resolve, timer: null, timeoutMs, maxBuffer };
      this.pending.set(requestId, pending);

      try {
        child.stdin.write(`${requestId}\t${duration}\t${commandB64}\n`, 'utf8', (error) => {
          if (error) this._failChild(child, `cannot write to WSL helper: ${error.message}`);
        });
      } catch (error) {
        this._failChild(child, `cannot write to WSL helper: ${error.message}`);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;

    const child = this.child;
    this.child = null;
    this._resolveAll(this._errorResult('WSL helper is closing'));
    if (child && child.stdin && !child.stdin.destroyed) child.stdin.end();
  }

  _ensureChild() {
    if (this.child) return this.child;
    if (this.now() < this.retryAt) return null;

    let child;
    try {
      child = this.spawn(this.command, this.args, {
        ...this.spawnOptions,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this._recordFailure(`cannot start WSL helper: ${error.message}`);
      return null;
    }

    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(child, chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    });
    child.once('error', (error) => {
      this._failChild(child, `WSL helper error: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      const detail = this.stderrBuffer.trim();
      const suffix = detail ? `: ${detail}` : '';
      this._failChild(child, `WSL helper exited (${signal || code})${suffix}`);
    });
    return child;
  }

  _onStdout(child, chunk) {
    if (child !== this.child) return;
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 32 * 1024 * 1024 && !this.stdoutBuffer.includes('\n')) {
      this._failChild(child, 'WSL helper returned an oversized protocol line');
      return;
    }

    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this._handleResponse(child, line);
    }
  }

  _handleResponse(child, line) {
    const fields = line.split('\t');
    if (fields.length === 2 && /^\d+$/.test(fields[0]) && fields[1] === 'start') {
      const pending = this.pending.get(fields[0]);
      if (pending && pending.timeoutMs > 0 && !pending.timer) {
        pending.timer = setTimeout(() => {
          this._failChild(
            child,
            `WSL helper did not answer within ${pending.timeoutMs + 2000}ms`,
          );
        }, pending.timeoutMs + 2000);
      }
      return;
    }
    if (fields.length !== 4 || !/^\d+$/.test(fields[0]) || !/^-?\d+$/.test(fields[1])) {
      this.onDiagnostic(`Ignoring unexpected WSL helper output: ${line.slice(0, 240)}`);
      return;
    }

    const pending = this.pending.get(fields[0]);
    if (!pending) return;

    let stdoutBuffer;
    let stderrBuffer;
    try {
      stdoutBuffer = Buffer.from(fields[2], 'base64');
      stderrBuffer = Buffer.from(fields[3], 'base64');
    } catch (error) {
      this._failChild(child, `invalid WSL helper response: ${error.message}`);
      return;
    }

    this.pending.delete(fields[0]);
    if (pending.timer) clearTimeout(pending.timer);

    const totalBytes = stdoutBuffer.length + stderrBuffer.length;
    if (totalBytes > pending.maxBuffer) {
      pending.resolve(this._errorResult(`WSL helper output exceeded ${pending.maxBuffer} bytes`));
    } else {
      pending.resolve({
        code: Number(fields[1]),
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
      });
    }

    if (this.failureCount > 0) this.onDiagnostic('WSL helper recovered');
    this.failureCount = 0;
    this.retryAt = 0;
  }

  _failChild(child, message) {
    if (child !== this.child) return;
    this.child = null;

    if (!this.closed) {
      this._recordFailure(message);
      if (!child.killed) child.kill();
    }
    this._resolveAll(this._errorResult(message));
  }

  _recordFailure(message) {
    this.failureCount += 1;
    const delay = transportBackoffMs(this.failureCount);
    this.retryAt = this.now() + delay;
    this.onDiagnostic(`${message}; next start in ${Math.ceil(delay / 1000)}s`);
  }

  _resolveAll(result) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pending.clear();
  }

  _errorResult(message) {
    return { code: 1, stdout: '', stderr: message };
  }
}

module.exports = {
  WSL_COMMAND_HELPER,
  WslCommandRunner,
  helperBootstrap,
  transportBackoffMs,
};
