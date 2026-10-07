# JOB_EVENTS — background-job observability contract

AgentTerm re-engages an idle AI agent when a background job it launched
finishes, and shows while such a job is running. Participation is opt-in
and job-side: a job reports itself by writing two kinds of file to a
spool. The reference implementation is the `agent-job` wrapper from
[agent-jobs](https://github.com/yunxin/agent-jobs), which does this for any
command it runs. Any tool can adopt the contract.

Agents need no knowledge of any of this to benefit, and whatever
re-engagement duty an agent's runbook imposes stands unchanged; everything
here is insurance underneath it. Telling the agent is still useful: an
agent that launches long jobs under `agent-job` can end its turn knowing
the host will hand it the result once the job finishes and it is idle.

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
resume still routes to it. When it is unset, no host is listening, and a
job writes nothing.

## What a job writes

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
- `msg` — one line, authored by the job, relayed to the agent
  **verbatim** (control characters stripped, never parsed by the host).
  Write it for the agent that launched the job: what ran, its outcome, one
  key link. Domain vocabulary — change numbers, verdicts, build URLs —
  lives here and only here; the host stays ignorant of it.

## What the host does

AgentTerm polls the spool every minute, resolving each start record's
liveness (`kill -0` on the filename pid) in the same read.

- A start record with a live process shows as a background-jobs indicator
  in the window's chrome bar, with a count once more than one is running;
  the tooltip names the commands. This survives a session resume — the CLI's own task display
  is gone after a resume, but the jobs and their records are not.
- An event for its session is delivered once, as a one-line notice into
  the agent's input, after the agent has been idle for the quiet period
  (two minutes by default) past both the job's finish and its own last
  output. A busy agent's report waits for its turn to end, so a job
  launched out of the CLI's sight still reaches it. Idle is judged on
  substantive screen output: spinner frames, token counters, and
  status-line repaints don't count as activity. A notice is held while
  the user is mid-compose. The event file is deleted on delivery.

      [Notice from terminal host] Background job report (as of 14:05):
      <msg> (ran 52m). Ignore if already handled.

- A start record whose process is gone with no event → a "gone without a
  completion report" notice quoting the record's `cmd`, under the same
  idle discipline with the death detected at the poll.
- The notice carries the clock time it was written and the run duration,
  derived from the timestamps; the absolute times go to the host's logs.
- Events persist until consumed. A spool file whose session window is gone
  for good is never claimed (each launch mints a fresh token) and ages out
  with the garbage collection (~7 days; behavior, not contract).
- **No delivery guarantee.** This is insurance; nothing may depend on it
  for correctness.
