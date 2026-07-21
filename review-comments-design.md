# Review comments — design

Inline commenting on a generated `review` page, reviewed in agent-term's
embedded web viewer, with comments flowing back to the agent and the agent
replying inline. Co-designed; this is the shared reference.

> **Scope of this doc:** the **host-side** reference — design rationale plus what
> agent-term's viewer *parses* and writes. The **normative, consumer-facing
> contract** (what a generator must emit / an agent must honor, with no access to
> this repo) lives with the generator, in `review`'s `PROTOCOL.md`. The host
> defines the format; the generator distribution publishes it. Keep the two in
> sync via the shared `version` / `FORMAT_VERSION` stamp.

## Principle

- **Diff HTML is static.** `review.py` regenerates it only when the *code*
  changes.
- **Comments are a separate JSON store**, rendered as a **live overlay** by the
  viewer (anchored via the `data-*` attributes the generator emits). Adding /
  replying / reading never regenerates the diff — it just rewrites the store.
- **The store is the single source of truth**, shared by the user (via the
  viewer) and the agent (via the filesystem). That is what makes the round-trip
  and inline agent replies work.

## Three actors, each doing only what it's good at

| Actor | Job |
|---|---|
| **`review.py`** (generator) | Emit anchoring markup. At regen, **deterministically re-anchor** every comment against the new diff and stamp `anchor_status` + updated `line` into the store. |
| **viewer** (agent-term `web-viewer.js`) | Render threads at the stamped `line`/`status` (dumb render — no matching). Compose / reply / resolve → write the store. Re-read on focus to show agent updates. |
| **agent** (LLM) | Read the store; address `open` threads (edit code, repoint the anchor on lines it changes); after regen, handle remaining `anchor_status:"lost"` (repoint or resolve); reply + set status. Runbook: `produce-review-pages.md`. |

Deterministic line bookkeeping (drift) → generator. Judgment (a rewritten /
deleted line) → agent. Placement → viewer. No actor does work it's bad at.

## Comment store — `<slug>-comments.json`

Lives **next to the generated page**, and the page lives **inside `.git`**:

```
<git-common-dir>/review/<branch>/<branch>.html
<git-common-dir>/review/<branch>/<branch>-comments.json
```

Why under `.git` (`git rev-parse --git-common-dir`):

- **Untracked by nature** — nothing in `.git` is tracked, so it needs no
  `.gitignore` entry (the project's is team-owned; we don't touch it).
- **Per-branch** — the `<branch>/` subfolder keeps reviews from colliding when
  several agents review different branches at once.
- **Common dir, not per-worktree** — shared across linked worktrees, so a review
  survives the worktree being removed, and is durable against `git clean -fdx`
  (which only nukes the working tree).

The page is a regenerable build artifact; the `-comments.json` is durable review
state. The viewer is **location-agnostic** — it just derives the comments path
from the page's `file://` URL (`*.html → *-comments.json`); only `review.py`
encodes the path convention. `--out` overrides it for ad-hoc pages.

```jsonc
{
  "slug": "add-rate-limiter",
  "threads": [
    {
      "id": "c1",
      "anchor": {
        "path": "src/limiter.py",   // repo-relative, == data-path
        "side": "new",              // old | new  (== data-side)
        "line": 42,                 // line number (== data-line); a hint
        "snippet": "if tokens <= 0:" // the line's text — the real anchor
      },
      "anchor_status": "ok",        // ok | moved | lost  (stamped by generator)
      "status": "open",             // open | read | answered | resolved
      "messages": [
        { "author": "user",  "ts": 1719500000, "body": "Why ceil not round?" },
        { "author": "agent", "ts": 1719500300, "body": "round() biased low; ceil keeps it >= the limit." }
      ]
    }
  ]
}
```

`snippet` is the anchor; `line` is only a hint to disambiguate. The snippet is
the diff cell's `textContent` at capture time.

## Status lifecycle

```
open ──(agent ingests)──> read ──(agent replies/edits)──> answered ──(user OK)──> resolved
  ▲                                                            │
  └──────────────── user posts a follow-up ───────────────────┘
```

- **open** — awaiting the agent.
- **read** — agent has ingested it ("already read by agent").
- **answered** — agent replied and/or changed code.
- **resolved** — closed.
- A user follow-up on a read/answered thread flips it back to **open**.

## Anchoring & re-anchoring

`data-path` (file `<section>`), `data-side` + `data-line` (each diff cell) are
emitted by the generator. The snippet = the cell text.

On regen the generator re-anchors each comment by matching its `snippet`:

- **`ok`** — same line.
- **`moved`** + new `line` — found elsewhere (drift). Auto-fixed; nobody intervenes.
- **`lost`** — snippet no longer in the diff. This is the agent's worklist:
  repoint (if it knows where the concept went) or resolve (target gone).

The viewer renders `ok`/`moved` at the line; `lost` floats to the file header
("code changed") with the agent's reply. The agent never has to scan — `lost`
flags are surfaced to it.

## Round-trip

1. Review in the viewer → select line(s) → compose → viewer writes a thread
   (`open`) to the store.
2. Click **Send to agent** (or just prompt) → viewer PTYs a short *pointer*
   naming the store's WSL/POSIX path and the open-thread count — "please
   address." (Rich data stays in the file; the terminal only gets a pointer.)
3. Agent reads the store, marks `read`, edits code where warranted, repoints
   anchors on lines it changes, appends replies, sets `answered`, re-runs
   `review.py` (which re-stamps anchor health for everything else).
4. Viewer re-reads the store on focus → replies + status appear inline; if the
   code changed it reloads the static diff and renders at the new stamped lines.
5. User reads replies, follows up (reopens) or resolves. Loop.

## UX

- **Gutter marker** on commented lines, coloured by status; reply count.
- **Click marker / select line** → thread expands inline below the row (diff
  stays put): messages with author + relative time + status badge, a reply box,
  Resolve. Reuses the markdown viewer's comment-card styling + batch send.

## Build phases

1. **Track A — anchoring markup** in `review.py`
   (`data-path/side/line` + `<body data-review="<slug>">`). **Done.**
2. **Store + IPC + read-only overlay** — viewer reads the store and renders
   existing threads inline. Proves anchoring. **Done.**
3. **Compose + send** — select→comment, write store, PTY pointer. **Done.**
4. **Replies + status + re-anchor stamping** — generator stamps `anchor_status`;
   agent writes replies/status; viewer shows badges + reply box; follow-up
   reopens; runbook in `produce-review-pages.md`. **Done.**

## Implementation map

- **Overlay** (render + compose/reply/resolve + floating *Send to agent*) lives
  in the **webview preload** `src/web-viewer-preload.js` — it runs inside the
  guest page and talks to main directly (`ipcRenderer.invoke`), so the page can
  do IPC that injected-from-host code can't. Self-contained (requires only
  `electron`), no-op on non-review pages.
- **Writes** — main is the **sole writer**: `rv-add-thread` / `rv-add-message` /
  `rv-set-status` do an id-keyed read-modify-write (per-path lock), `rv-send-to-
  agent` PTYs the pointer. The host (`web-viewer.js`) only sets the preload and
  pings `rv-refresh` on focus.
- **Re-anchoring** — `review.py reanchor_comments()` re-stamps every thread's
  `anchor_status` (and `line` for `moved`) against the new diff on each regen,
  touching anchors only (never message bodies / status).
