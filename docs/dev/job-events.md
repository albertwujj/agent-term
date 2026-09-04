# JOB_EVENTS — background-job observability contract

AgentTerm re-engages an idle AI agent when a background job it launched
finishes, and shows while such a job is running. Participation is opt-in
and script-side: a job reports itself by writing two kinds of file to a
spool, by pasting the reference stanza below, sourcing it from
[agent-jobs](https://github.com/yunxin/agent-jobs), or launching under
that repo's `agent-job` wrapper. Any tool can adopt the contract.

Agents need no knowledge of any of this to benefit, and whatever
re-engagement duty an agent's runbook imposes stands unchanged; everything
here is insurance underneath it. Telling the agent is still useful: an
agent that launches long jobs under `agent-job` can end its turn knowing
the host will hand it the result once the job finishes and it has been
idle since.

## What the host provides

`AGENT_SESSION_ID` — a short alphanumeric token identifying one terminal
session (one window). An ordinary environment variable — same mechanism as
`TERM` or iTerm2's `ITERM_SESSION_ID`: AgentTerm sets it on the shell it
spawns (on Windows also listed in `WSLENV`, so it crosses into WSL), and
normal parent-to-child inheritance carries it to every process in the
session — which is exactly what scopes it to one window. The token is the
routing key: several sessions run at once, and it decides which window's
agent a signal re-engages. It names the session, not the process: when
AgentTerm resumes a recorded session in a new window, that window keeps the
session's token, so a job (or an agent-lock owner record) started before the
resume still routes to it. When it is unset, no host is listening, and the
reference stanza below is a no-op by design.

## What a script writes

Both files live in the spool, `${TMPDIR:-/tmp}/agent-events/`, named by
the writing process: `<epoch>.<pid>.started` and `<epoch>.<pid>.event`.
Unknown fields are ignored; fields may be added over time.

**1. A start record, at launch — removed on exit.**

    session=a1b2c3
    started=2026-07-05T15:20:11Z
    cmd=watch-build.sh --url https://…

While the record's process lives, the host knows a job of this session is
running. A record whose process is gone with no completion event means the
result is never coming — the SIGKILL/OOM case, where no exit trap ran.
`cmd` is what the host shows for the job (indicator tooltip, and the
"gone" notice below).

**2. A completion event, on exit — the primary signal.**

    session=a1b2c3
    ts=2026-07-05T16:12:52Z
    started=2026-07-05T15:20:11Z
    msg=watch-build.sh change 123456: VERDICT=REAL_FAIL https://…

- `session` — the sanitized token (`tr -cd 'A-Za-z0-9'`); routing only.
- `ts`, `started` — exit and launch time, UTC ISO 8601; the host shows the
  run duration in the notice and logs the absolute times.
- `msg` — one line, authored by the script, relayed to the agent
  **verbatim** (control characters stripped, never parsed by the host).
  Write it for the agent that launched the job: what ran, its outcome, one
  key link. Domain vocabulary — change numbers, verdicts, build URLs —
  lives here and only here; the host stays ignorant of it.

## What the host does

AgentTerm polls the spool every minute, resolving each start record's
liveness (`kill -0` on the filename pid) in the same read.

- A start record with a live process shows as a background-jobs indicator
  in the window's chrome bar: presence only, the tooltip naming the
  commands. This survives a session resume — the CLI's own task display
  is gone after a resume, but the jobs and their records are not.
- An event for its session is delivered at most once, as a one-line
  notice into the agent's input, and only to an agent that was idle when
  the job finished and stays idle for the quiet period after it (two
  minutes by default). An agent that was awake at the finish, or that woke
  within the period, already has the result from its own environment (a
  self-waking CLI's background-task notice, its own check) or is mid-turn,
  where a queued notice would land after the turn as a stale second
  report; its event is consumed silently instead. Awake is judged on
  substantive screen output: spinner frames, token counters, and
  status-line repaints don't count as waking. A notice is held while
  the user is mid-compose. Either way the event file is deleted once
  decided.

      [Notice from terminal host] Background job report: <msg> (ran 52m).
      Ignore if already handled.

- A start record whose process is gone with no event → a "gone without a
  completion report" notice quoting the record's `cmd`, under the same
  idle discipline with the death detected at the poll. An agent active
  around the detection most likely killed the job itself; its record is
  consumed silently.
- The notice carries no wall-clock times — the run duration is derived
  from the timestamps; absolute times go to the host's logs.
- Events persist until consumed. A spool file whose session window is gone
  for good is never claimed (each launch mints a fresh token) and ages out
  with the garbage collection (~7 days; behavior, not contract).
- **No delivery guarantee.** This is insurance; nothing may depend on it
  for correctness.

## Reference stanza

Paste into a bash script (or a shared prelude it sources). Inert without a
host; silent when nested under another participating script
(`_AGENT_JOB_TOP` is inherited), so a wrapper that reuses an inner script
reports exactly once — from the outermost process. agent-jobs carries this
same stanza as a sourceable file, plus the `agent-job` wrapper and the
`AGENT_JOB_MSG_FILE` forwarding that connects the two.

```bash
# --- background-job observability (agent-term job-events.md) ------------
if [ -n "${AGENT_SESSION_ID:-}" ] && [ -z "${_AGENT_JOB_TOP:-}" ]; then
  _aj_sess=$(printf '%s' "$AGENT_SESSION_ID" | tr -cd 'A-Za-z0-9')
  export _AGENT_JOB_TOP=$$
  _aj_started=$(date -u +%FT%TZ)
  _aj_dir="${TMPDIR:-/tmp}/agent-events"
  _aj_start="$_aj_dir/$(date +%s).$$.started"
  { mkdir -p "$_aj_dir" && printf 'session=%s\nstarted=%s\ncmd=%s\n' \
      "$_aj_sess" "$_aj_started" "$(basename "$0")${*:+ $*}" \
      > "$_aj_start"; } 2>/dev/null || true
  AGENT_JOB_MSG=""   # set before exiting for a self-describing report
  _aj_event() {
    _aj_rc=$?
    mkdir -p "$_aj_dir" 2>/dev/null || return 0
    printf 'session=%s\nts=%s\nstarted=%s\nmsg=%s\n' \
      "$_aj_sess" "$(date -u +%FT%TZ)" "$_aj_started" \
      "${AGENT_JOB_MSG:-$(basename "$0") exited rc=$_aj_rc}" \
      > "$_aj_dir/$(date +%s).$$.event" 2>/dev/null || true
    rm -f "$_aj_start" 2>/dev/null || true
  }
  trap 'exit' HUP INT TERM PIPE QUIT   # funnel graceful signals into the EXIT trap
  trap _aj_event EXIT
fi
```

Set `AGENT_JOB_MSG` before exiting for a self-describing report; otherwise
the event records the script name and exit code. The signal funnel turns
graceful and pipeline deaths into ordinary events; only SIGKILL-class
deaths skip the trap — which is exactly what the start record covers.

To opt a single invocation out, clear the token for that command:
`AGENT_SESSION_ID= script …` — the stanza is then a no-op for that job.
