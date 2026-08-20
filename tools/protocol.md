# Review-comments protocol

The contract a **generated review page** + its **comment store** must satisfy to
work with a conforming review host (the reference host is *agent-term*, which
renders the page, overlays comments, captures the user's comments, and pings the
agent). 

**Audience: generator/host authors — NOT the reviewing agent.** This is the format
spec for someone *building or replacing* the generator or the host. The AI agent
that authors reviews does **not** see this file and does not need it: it ships only
with the `agent-threads` docs (`code/authoring.md` + `code/produce-review.md`) and writes a
markdown *package*, never the page markup or store internals described here. So
nothing below is an instruction to that agent — don't phrase it as one.

This document is self-contained: a generator author does not need the host's source.
`review.py` is the reference generator — modify or replace it as long as its
output still conforms; verify with `python review.py --check <page.html>`.

`FORMAT_VERSION = 1` (the comment store carries a matching `version`).

## Roles

| Role | Who | Changeable by the agent? |
|---|---|---|
| **Host** | the review app (agent-term) — renders, overlays, captures, routes | **No** — installed app, source not available |
| **Generator** | `review.py` or any tool you run | **Yes** — modify or replace; must stay conformant |
| **Agent** | the AI CLI hosted in the terminal (you) | — |

The contract is **between formats, by convention — there is no API**. The host
*parses* the page + store; conform to the formats below and any host works.

## 1. The page — anchoring markup (generator MUST emit)

The host activates the comment overlay only on a page that opts in and carries
anchors:

- `<body data-review="<slug>">` — the opt-in marker. Without it the page is
  shown as a plain page (no overlay).
- `<section data-path="<repo-relative-path>">` — one per file in the diff.
- Each diff **line cell** carries both `data-side="old|new"` and
  `data-line="<n>"`. The cell's **`textContent`** is the line's snippet (the
  anchor text). `old`/`new` is the side of a split diff; `data-line` is that
  side's line number.

The host reads **only** these attributes. Everything else — layout, styling,
syntax highlighting, navigation — is free. Do not remove or rename these
attributes; they are load-bearing.

**Rendered (preview) sections.** A generator MAY render a file as an in-place
*rendered* diff instead of source cells (e.g. markdown rendered with inline
`<ins>/<del>`). Such a section still has its `data-path`, but anchors at **block
granularity**: each prose block carries `data-side` + `data-line` (the source
line of that block), rather than per-line cells. Comment threads anchor the same
way (`path/side/line/snippet`); only the *compose* affordance differs (block vs
line gutter). The commit-message block is anchored the same way.

**Context (code-view) sections.** A generator MAY embed a slice of a file as it
stands at the range tip, with no diff (the package's `:::code` directive). Such a
section carries `data-path` like a diff section and one code column whose cells
carry `data-side="new"` + `data-line`; there is no old side. The host treats the
cells exactly like diff cells: compose, anchor, re-anchor. The generator MAY put
the agent's explanation beside the code as a nested
`<section data-path="(note N)">` prose region; a thread quoted from it is an
ordinary region anchor. Several sections may share one `data-path` (two ranges
of a file, or a diff plus a context slice): the host locates a code anchor by
searching every section of that path for its `data-side`/`data-line` cell, and
floats a `lost` thread to the first one's header.

## 2. The comment store — `<page-stem>-comments.json`

**Location is by convention, not configuration.** The host derives the store
path from the page URL it is showing: `…/<name>.html → …/<name>-comments.json`
(sibling). The generator therefore MUST write the store next to the page. The
reference location for both is:

```
<git-common-dir>/review/<branch>/<branch>.html
<git-common-dir>/review/<branch>/<branch>-comments.json
```

(inside `.git`: untracked by nature, per-branch, shared across worktrees, safe
from `git clean`). `review.py --where` prints the resolved page path; the
store is that with `.html → -comments.json`.

### Schema

```jsonc
{
  "version": 1,
  "threads": [
    {
      "id": "t…",                       // stable key, assigned by the host on create
      "anchor": {
        "path": "src/x.py",             // == a section's data-path
        "side": "new",                  // old | new  (== data-side)
        "line": "42",                   // == data-line (string)
        "snippet": "if tokens <= 0:"    // the cell's textContent — the real anchor
      },
      "anchor_status": "ok",            // ok | moved | lost  (generator-stamped)
      "status": "open",                 // open | read | answered | resolved
      "messages": [
        { "author": "user",  "body": "…", "ts": 1719500000000 },
        { "author": "agent", "body": "…", "ts": 1719500300000 }
      ]
    }
  ]
}
```

### Region anchors and edit threads

A thread on **prose** (the commit message, package prose, a rendered preview)
carries a *region* anchor instead of a code anchor: `path` (the section's
`data-path`, e.g. `(commit message)`), `snippet` (the quoted text — the real
anchor), optional `context`, `wholeBlock`, and `heading`; **no `side`/`line`**.
On regen the generator stamps a region anchor `ok` while its snippet still
appears on the page, else `lost`.

A thread whose first user message is wrapped in `[Edit]…[/Edit]` is a
**suggested edit**: the passage as rendered, with `<del>`/`<ins>` marks for the
user's deletions/insertions. The host composes these on the commit-message
blocks and renders them as an inline diff (in place while the original text
still matches, in the card otherwise). To the generator it is an ordinary
thread — anchors only, never the body. An optional second user message on the
same thread is the user's note about the edit.

### Field ownership — what makes shared-write safe

Two processes write this file: the **host** (on the user's actions) and the
**agent/generator** (on the agent's turn). There is **no cross-process lock** —
safety comes from **turn-based discipline + one owner per field + append-only
messages**:

| Field | Written by | Rule |
|---|---|---|
| `thread.id` | host (on create) | stable; never reassigned |
| `messages[]` | append-only — host appends `user`, agent appends `agent` | never edit or delete another author's message |
| `status` | shared — user (resolve/reopen) via host; agent (read/answered/resolved) | last-writer-wins; safe only because turns don't overlap |
| `anchor.{path,side,line,snippet}` | generator updates `line` on regen; agent may repoint on `lost` | |
| `anchor_status` | generator only (on regen) | `ok` / `moved` / `lost` |

Append-only governs **cross-author** safety. While a thread is still wholly the
user's — `open`, every message user-authored — the host may rewrite or remove
the user's own messages (revising a pending edit, discarding it). Once an agent
message exists, the thread is a conversation and append-only is absolute.

## 3. Re-anchoring (generator MUST do on regen)

Code moves between regenerations, so on every regen the generator re-stamps each
existing thread against the **new** diff by matching its `snippet` within the
same `path` + `side`:

- **`ok`** — snippet still at the same line.
- **`moved`** — snippet found at a different line → update `anchor.line` to it.
- **`lost`** — snippet no longer in that file's diff.

Context-section lines are indexed on the `new` side like diff lines, so a thread
on one re-anchors the same way.

The generator touches **only** `anchor_status` and `anchor.line`; it MUST NOT
alter `messages` or `status`. The host renders `ok`/`moved` inline at the line
and floats `lost` to the file header.

## 4. Routing (host → agent)

The host has no API to the agent. It **types a natural-language pointer** into
the terminal where the agent runs, naming the store's path (and, for a single
comment, the file:line + text). Rich data never crosses the terminal — only a
pointer. A conforming agent recognizes such a pointer and reads the store.

**Notify buttons.** A page MAY carry `<button class="rv-regen"
data-rv-regen="<kind>">` in a banner; a click makes the host type the fixed
prompt for that kind — `refresh` (uncommitted changes), `diverged` (HEAD off the
range's branch), `scope` (unusable scope), `issues` (structural problems in the
package: a directive that fails to parse, a bad range, an embed with nothing to
show). The page sends only the kind, never text. For `issues` the generator
MUST write the list beside the page as `<page-stem>-issues.json` (a JSON array
of strings) and remove it once the package is clean; the prompt points the
agent at that file.

## 5. The agent's round-trip

Read the store; address each non-resolved thread — mark `read`, edit code where
warranted, append an `{"author":"agent",…}` reply, set `answered`; on a `lost`
anchor (snippet gone because you rewrote that code) repoint `anchor` or reply +
`resolved`; then **regenerate** (which re-anchors everything else). The
step-by-step runbook is `code/produce-review.md`.

## 6. Conformance

You may change or replace the generator — verify the page still conforms:

```
python review.py --check <page.html>
```

It asserts the page carries `data-review`, per-file `data-path`, and cells
with `data-side` + `data-line`. Run it after any change to the generator's
rendering, before handing a page to the user.

**Versioning:** the store's `version` and this `FORMAT_VERSION` must match a
host that parses them. Bump on any breaking change to the markup or schema so an
old generator paired with a newer host fails loudly instead of silently.

## 7. Invariants (the standard)

1. **The host is semantics-free** — it renders HTML + a JSON overlay and routes
   text; it knows nothing about diffs or review logic.
2. **The store is the bus** — all rich state lives in the file; the terminal
   carries only a pointer.
3. **Page disposable, store durable** — regen replaces the HTML; it never
   clobbers store content (anchors only).
4. **Coupling by convention, not API** — URL→store derivation, the `data-*`
   attributes, the NL pointer. Swap the generator or the host freely.
5. **Turn-based, not concurrent** — the user and the agent never write at the
   same time; there is no distributed lock.
