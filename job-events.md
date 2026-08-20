# JOB_EVENTS — background-job observability contract

AgentTerm re-engages an idle AI agent when a background job it launched
finishes. The common case needs no cooperation: jobs that stay in the
session's process tree are noticed from the host side. This file documents
the *optional* contract a script can implement to make that signal explicit,
durable, and richer — and what the host does in return. Any tool can adopt
it, by pasting the reference stanza below or sourcing
[agent-jobs](https://github.com/yunxin/agent-jobs).

Agents need no knowledge of any of this. Whatever re-engagement duty an
agent's runbook imposes stands unchanged; everything here is insurance
underneath it.

## What the host provides

`AGENT_SESSION_ID` — a short alphanumeric token identifying one terminal
session (one window). An ordinary environment variable — same mechanism as
`TERM` or iTerm2's `ITERM_SESSION_ID`: AgentTerm sets it on the shell it
spawns (on Windows also listed in `WSLENV`, so it crosses into WSL), and
normal parent-to-child inheritance carries it to every process in the
session — which is exactly what scopes it to one window. The token is the
routing key: several sessions run at once, and it decides which window's
agent a signal re-engages. When it is unset, no host is listening, and the
reference stanza below is a no-op by design.

## What a script can do

**1. Label its process — opts into liveness watching.** Carry the token in
the command line; the reference stanza re-execs once with argv[0] decorated:

    watch-build.sh[sess:a1b2c3] --url https://…

A labeled process that disappears while the agent is idle, with no matching
completion event, earns the agent a "gone without a completion report"
notice — the SIGKILL/OOM case, where a result is never coming.

**2. Drop a completion event — the primary signal.** On exit, write one
file to the spool:

    ${TMPDIR:-/tmp}/agent-events/<epoch>.<pid>.event

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

Unknown fields are ignored; fields may be added over time.

## What the host does

AgentTerm polls the spool every minute, and the session's process list
while the agent is quiet.

- Every event for its session is delivered, exactly once: a one-line
  notice into the agent's input, then the event file is deleted. Delivery
  is prompt — the next poll — and held only while the user is mid-compose;
  it then lands right after their submit, riding the CLI's own input queue
  if a turn is running. On self-waking CLIs a notice can be redundant by
  design — it ends with "ignore if already handled".

      [Notice from terminal host] Background job report: <msg> (ran 52m).
      Ignore if already handled.

- A labeled process gone with no event → a "no completion report" notice
  quoting the process's own command line.
- The notice carries no wall-clock times — the run duration is derived from
  `started`/`ts`; absolute times go to the host's logs.
- Events persist until consumed. An event whose session window is gone for
  good is never claimed (each launch mints a fresh token) and ages out with
  the garbage collection (~7 days; behavior, not contract).
- **No delivery guarantee.** This is insurance; nothing may depend on it
  for correctness.

## Reference stanza

Paste into a bash script (or a shared prelude it sources). Inert without a
host; silent when nested under another participating script
(`_AGENT_JOB_TOP` is inherited), so a wrapper that reuses an inner script
reports exactly once — from the outermost process:

```bash
# --- background-job observability (agent-term job-events.md) ------------
if [ -n "${AGENT_SESSION_ID:-}" ] && [ -z "${_AGENT_JOB_TOP:-}" ]; then
  _aj_sess=$(printf '%s' "$AGENT_SESSION_ID" | tr -cd 'A-Za-z0-9')
  if [ -z "${_AGENT_JOB_RELABEL:-}" ]; then
    # opt into liveness watching: surface the session token in argv[0]
    _AGENT_JOB_RELABEL=1 exec -a "$(basename "$0")[sess:$_aj_sess]" bash "$0" "$@"
  fi
  export _AGENT_JOB_TOP=$$
  _aj_started=$(date -u +%FT%TZ)
  AGENT_JOB_MSG=""   # set before exiting for a self-describing report
  _aj_event() {
    _aj_rc=$?
    _aj_dir="${TMPDIR:-/tmp}/agent-events"
    mkdir -p "$_aj_dir" 2>/dev/null || return 0
    printf 'session=%s\nts=%s\nstarted=%s\nmsg=%s\n' \
      "$_aj_sess" "$(date -u +%FT%TZ)" "$_aj_started" \
      "${AGENT_JOB_MSG:-$(basename "$0") exited rc=$_aj_rc}" \
      > "$_aj_dir/$(date +%s).$$.event" 2>/dev/null || true
  }
  trap 'exit' HUP INT TERM   # funnel graceful signals into the EXIT trap
  trap _aj_event EXIT
fi
```

Set `AGENT_JOB_MSG` before exiting for a self-describing report; otherwise
the event records the script name and exit code. Only SIGKILL-class deaths
skip the trap — which is exactly what the label (mechanism 1) covers.

To opt a single invocation out, clear the token for that command:
`AGENT_SESSION_ID= script …` — the stanza is then a no-op for that job.
