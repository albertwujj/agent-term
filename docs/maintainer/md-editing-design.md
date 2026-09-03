# Markdown Viewer — Direct Editing Design

Decisions from design discussion, 2026-07-10. Companion to `md-viewer-discovery.md`
(current comment/refresh architecture) and `review-comments-design.md` (review viewer).

## Philosophy

User edits express intention; they are not final text. Typing a change directly is
the cheapest way to show the agent what you want, cheaper than describing it in a
comment. The agent interprets the edit, fixes grammar/spelling/fragments, adjusts
surrounding text for consistency, and preserves the user's meaning and voice.

Consequences that drive everything below:

- The user's words on screen are a gesture; the file on disk is truth.
- The agent is the interpreter for every ambiguity, including edit conflicts.
- The trust loop requires the user to see, effortlessly, how the agent handled
  their intent. Recovery from misinterpretation is just another editing turn.

## Layout: flip-paged spread

Two facing pages of one continuous text, always; on narrow windows the pages
get narrower (the viewer is not used on small screens). Reading order inside a
spread is left page then right page, with ~1.5 overlap lines repeated at the
seam. The only motion is the flip: a wheel/trackpad gesture or
PageDown/ArrowDown/Space (PageUp/ArrowUp/Shift+Space back, band-focused)
advances a whole spread — 2× page advance, which repeats the seam overlap
across the flip so the new left page continues the old right page. Continuous
scrolling was the old spread's failure: small scrolls animated text without
revealing anything new. Pages are viewport-relative (a flip is scrollBy, no
global page grid), so live agent updates preserve position exactly as a
scroll view would.

Measure: 66ch at 17px Charter/Georgia (~75 chars/line) per page.

Keep-together: a thread card or resting row is one unit (its messages, its
Reply, its composer), so unlike a paragraph it is never cut by a page edge.
A box that would straddle a page top gets a blank spacer before it, in both
article copies, moving it whole onto that page; the page before ends above it
(the bottom trim treats a box like a line), leaving a blank tail the way a
book moves a figure. Seating is computed from the current page top downward
against the live grid; boxes above the page top keep the spacer they last got
(recomputing them would move the reader's top line), with heights remembered
by box key so a re-render restores them verbatim. A box taller than a page
splits on its lines like text. The card hosting an open reply composer is
fitted onto its page by scroll instead, the comment bubble's precedent, so a
growing reply never throws the card onto another page; the other copy carries
a blank of the composer's height so the facing page keeps lining up.

## Mode dispatch: the first key decides

Commenting and editing share the existing target gesture (click a block, or
make a selection) and the first keystroke routes by class, matching the
behavioral asymmetry of agent-assisted writing: comments begin with words;
edits begin with removing something. Today's comment flow survives verbatim —
zero regression.

The rule is one sentence: letters comment; every other key edits at the
caret; the caret is where the mouse clicked; Esc cancels.

- A letter → comment composer, seeded with it (today's path). Paste shortcut →
  comment seeded from the clipboard (unchanged). A comment that must open with
  a digit ("3 issues:") starts with a letter or gets typed after the composer
  is open — accepted cost.
- Any other key → the block editor opens with the caret at the click position,
  and the key applies its normal editing effect: Backspace/Delete deletes (a
  live selection deletes as in any editor), digits/punctuation/space insert,
  arrows move the caret without mutating, Enter is a newline.
- Space/arrows/Page keys flip only while nothing is targeted; a click hands
  them to the editor.
- Entry keys split by whether they mutate: Backspace/Delete and
  digits/punctuation apply their edit immediately (high-intent keys); Enter,
  Space, and arrows enter the editor without inserting (a stray Enter must not
  split a paragraph; a stray Space must not sprinkle whitespace). Inside the
  editor every key is normal.
- Stray-edit safety is layered undo, never an arming keystroke (which would
  re-tax the fast path the dispatch exists for): entry is loud (the block
  visibly swaps to source), Esc reverts the open editor session, Cmd+Z works
  inside, and every surviving hunk stays a visible amber bar + discardable
  card until Cmd+Enter — a stray never touches disk or the agent.
- Typing a letter over a selection comments on it (today's flow, preserved).
  Replace-by-typing is therefore deliberately two-step: ⌫ deletes the
  selection as an edit, then type. Double-click keeps its native meaning —
  select a word — which composes: double-click + ⌫ deletes that word as an
  edit; double-click + letter comments on it. The one-step reflex has a
  recovery: ⌘E in the composer converts the card to an edit (see "Edit
  instead", 2026-08-30).
- Only unmodified keys dispatch; Cmd/Ctrl chords pass through (copy, search,
  send). "Letter" = any Unicode letter (\p{L}); IME composition never
  dispatches mid-composition.
- Esc keeps its ladder: cancel the editor/composer, then clear the target,
  then roll the band up.
- The hint teaches the split: "Type to comment · other keys edit". Until the
  editor opens there is no visible caret; the click position is held
  invisibly and materializes as the caret on the first editing key.

Editor mechanics (unchanged from the earlier design): Obsidian-style live
preview per block — the block swaps to an inline editor showing its markdown
source, styled to match; all other blocks stay rendered; re-render on exit.
The `data-source-start-line`/`end-line` map makes the swap exact. No
contenteditable over the whole article, no HTML→markdown round-trip. Inside
the editor every key types; Enter is a newline.

The read-only toggle from the earlier draft is dropped: printable strays now
route to a composer (no mutation), so the only mutating stray is ⌫ on a
selection, which is visible, pending, and revertible.

## Pending batch

- At turn start the viewer snapshots the source as **baseline**.
- As the user types, a line diff against baseline (reuse `getLineDiffOpcodes`)
  groups contiguous changed regions into **hunks**. A hunk is the unit of
  pending work: one card, one `[Edit]` in the envelope.
- Cards are recomputed net diffs, never event logs: repeated edits to the same
  passage stay one card; a manually reverted edit makes its card disappear;
  structural edits (paragraph split/merge) stay one contiguous hunk.
- Queued comments join the same batch.
- A comment placed on a dirty hunk automatically becomes that edit's note
  (`[Note]` nested in `[Edit]`); on a clean block it is an independent
  `[Comment]`. No user-facing distinction to choose.

## Margin UI

(Written for a single-column layout; the flip-paged spread consumes wide-window
margins, so annotation placement is reopened — see Open questions.)

- **Right margin**: one card per hunk (mini-diff, add-note, discard) and per
  queued comment, aligned with its block. Discard on an edit card reverts the
  block to its before-text.
- **Inner gutter**: thin change bars hugging the text edge. Amber = pending
  edit; agent-change color = agent wrote here.
- **Pill** (bottom corner, exists only while the batch is non-empty):
  "2 edits, 1 comment · ⌘↩ send". Click opens a jump list of all pending items
  (margin cards are only visible when their block is on screen).

## Highlighting

- The user's own pending edits get no in-text highlighting; the margin bar and
  card carry the state. Hovering bar or card may flash the changed ranges.
- Agent changes: keep the transient pulse, then settle to a margin bar with
  ranges shown on hover. No persistent in-text highlights (current settled
  highlights are distracting).
- After handoff, highlight only where the agent's result deviates from the text
  the user submitted. No highlight means the user's words survived verbatim.

## Pending presentation, envelope, and the two-sided clock (2026-07-11 pm)

Revisions after living with the first editing build; supersedes the
mini-diff-card idea and parts of Pending batch / Margin UI.

- **Pending edits render in place, on the rendered text.** When the mapping
  is exact (rendered text equals the new source line — plain prose, the
  dominant case), the block stays typeset with deleted words struck in place
  and inserted words marked amber; sent-but-unconsumed edits show the same
  decoration in slate. Markup-heavy lines, structural hunks, and conflict
  leads fall back to a source-mode diff box (accepted fallback, 2026-07-11).
  A live preview inside the open editor shows the merged diff from the
  first keystroke.
- **Edits have no cards.** The in-place diff carries a micro-action strip:
  undo (revert this hunk) and note (a small composer; the text rides the
  edit's thread as a second message at send — [Note] realized through
  threads). Undo ladder: Esc = open editor session; `↶` = one hunk (the
  live pill and the resting mark share this glyph). Comment drafts stay one card per comment, restyled
  into the thread-card family (amber draft accent, per-card ✕,
  click-to-re-edit).
- **One send.** Composer Enter, the pill, and ⌘↩ are the same action:
  send everything pending — hunk threads plus comment drafts — as one turn.
  "Send all (N)" counts both kinds. The comment footer (count + Discard in
  the band bar) is retired; the pill is the only aggregate.
- **Envelope = the same representation.** Inside [Edit], intra-line
  modifications are merged text with <del>/<ins> tags (the agent sees the
  change at its position: "The polling <del>utilizes</del><ins>uses</ins> a
  timer"); structural hunks keep -/+ line blocks. Viewer rendering and
  envelope come from one word-diff pass.
- **The clock becomes two-sided.** The store gains `agent_seen_turn`,
  advanced by the agent (via the tool below) as it consumes turns. It
  drives clearing in the agent→user direction, symmetric to collapse in the
  user→agent direction: sent in-place diffs keep a "sent" tint until
  `agent_seen_turn` covers their turn, then their blocks return to rendered
  text — the user watches edits get consumed. It also substitutes for the
  per-thread `read` stamp when an agent skips it (turn ≤ agent_seen_turn ⇒
  ingested).
- **Incremental consumption tool** (agent-threads, and the md+script pairing
  in the kits): one verb — enumerate the messages with turn > agent_seen_turn,
  and advance the baseline to the store's current turn in the same atomic
  write. Enumeration IS advancement: separate bookkeeping gets skipped
  (validated — the cold agent skipped the read stamp), fused behavior
  always happens. Premature advance (agent dies after enumerating)
  degrades gracefully: the baseline is the attention cursor, never the
  work queue — open status keeps the threads in every pointer count, and
  the doc already holds the edits. Peek-without-consuming = read the JSON.
  The baseline lives in the store, so it survives agent compaction,
  restarts, and agent swaps; concurrent user activity lands in the next
  enumeration (turns are atomic consumption units). Runbooks reference the
  tool only once it ships.

## Threads (2026-07-11; supersedes parts of Highlighting and Handoff)

The review viewer's thread model extends to the md viewer. Full consistency
between the two viewers wherever it makes sense, sharing code.

- **Ambient vs engaged.** Unengaged agent changes stay ephemeral: pulse, then
  a single-shade gutter bar (age shades are dropped — a shade ladder can't be
  decoded by a reader; retention window unchanged). Anything either side makes
  conversational is a thread: a user edit or comment always starts one; a
  barred agent change can be promoted to one (the change record's
  before/after becomes the opening content). Bars are the pre-thread state.
- **Store**: hidden sidecar next to the doc (`.<name>-comments.json`), same
  schema as the review store (version / threads / anchor / status / messages)
  plus two shared additions: `title`, and the `turn` logical clock — a
  store-level counter of user send-batches, viewer-ticked, stamped onto every
  message at write time. Same IO discipline: main is the sole viewer-side
  writer (atomic tmp+rename, per-path lock, filename-guard generalized); the
  agent edits the JSON directly, append-only.
- **Titles**: the agent names an edit-born thread while processing the turn
  (short intent summary). Collapsed-line fallback ladder: `title` → anchor
  snippet → "User edits".
- **Collapse is derived from the logical clock; md has no resolve.**
  Collapsed = answered where the latest agent reply's `turn` is below the
  store's current `turn` (the user sent a later batch — action is the proof
  of attention; wall-clock "seen on screen" stamps false positives whenever
  the user is away). `open` never auto-collapses. A session-local override
  expands or folds any thread by hand; the clock catches up at the next
  send. A follow-up IS the reopen — no separate action, no resolved state:
  nothing consumes it (pointer counts open only; the agent works open only;
  collapse is the clock's). Review keeps its explicit resolve until
  unification, where the clock is expected to absorb it too.
- **Send protocol unifies on review's**: pointer + open-thread count into the
  PTY; content lives in the store (md's inline envelopes existed only because
  md was storeless). The edit envelope becomes the thread's first message.
- **The host introduces the document.** Review's loop starts agent-side (an
  action verb, `@produce-review.md`), so the agent knows where things live;
  the md loop starts host-side (the user clicked an md). The pointer therefore
  carries the entry document's path, the store path, the open count, and the
  resolved runbook path. Every host-resolved runbook follows the same
  nearest-wins rule (the nearest-`commit-message.md` convention): start in the
  governed document's directory and walk its direct ancestors, so a repo can
  vendor its own copy. Exact fallbacks then check inside the session's current
  repo, beside that repo (the sibling agent-repo layout), and finally `$HOME`.
  For md threads the relative runbook is `agent-threads/md/user-intent.md`. The
  runbook is a required install: no hit anywhere fails the send fast with an
  actionable error — no inline protocol fallback (it would mask the broken
  install and fork the contract).
- **Anchors**: md threads use the prose snippet anchor (snippet / context /
  heading). No generator exists for md, so the md viewer stamps
  `anchor_status` (ok / moved / lost) itself on refresh.
- **Rendering**: collapsed threads are review-style inline disclosure lines
  after the anchored block (proven default; the margin question stays open).
- **Shared-code targets**: store IO + lock; schema + lifecycle + collapse
  rule; one agent round-trip protocol doc covering both viewers; thread-card
  renderer as a shared module bundled into both hosts (the comment-ui
  pattern); one snippet-match core behind both anchor flavors.

## Handoff

Cmd+Enter anywhere (or the pill's Send button) ends the user's turn. Empty batch
= no-op. Closing the viewer with pending edits prompts keep-or-discard.

Sequence:

1. **Rebase** — read the fresh file; re-anchor each hunk (see Conflicts).
2. **Write** — apply clean hunks to the fresh content, write the file once.
   Sending is the save; there is no separate save step.
3. **Inject** — one envelope into the PTY (bracketed paste + CR, same path as
   comments today): all hunks with notes, plus independent comments, in
   document order, then the standing instruction block.
4. **State flip** — tray clears, amber bars turn to a "sent, awaiting agent"
   tint, refresh unblocks. The agent's follow-up write comes back through the
   existing poll; deviation highlighting closes the loop.

Envelope sketch:

```
I edited the markdown document directly:
<filePath>
Section: Setup > Install

[Edit]
- old text of the hunk (with a line or two of context)
+ new text
[Note]
optional clarifying note
[/Note]
[/Edit]

[Comment]
independent comment, quoting its target as today
[/Comment]

My edits express intent, not final wording. Re-read the file from disk, then
fix grammar and spelling, complete fragments, and adjust surrounding text for
consistency. Keep my meaning and voice.
```

The trailing instruction block is a default template shipped by agent-term,
overridable per project (e.g. `.agentterm/edit-instructions.md`). "Re-read the
file from disk" defends against the agent rewriting from a stale in-context copy.

## Conflicts (agent writes during the user's turn)

A conflict is a referent question — does the passage the user gestured at still
exist? — and the agent resolves it. There is no merge UI, no conflict dialog.

- **During the turn**: freeze the view (extend the existing refresh-blocking
  state to the whole dirty period). If the file changes underneath, the pill
  notes "agent updated the file · reconciles on send". The CLI agent cannot be
  paused; freezing the view is the honest form of "agent backs off".
- **At handoff**, per hunk:
  - Referent intact (agent edited elsewhere): apply the user's text to the
    fresh content and write. Silent, and the common case.
  - Referent changed or gone: do not write the user's text. Ship the hunk as an
    intent-forward: "I edited this passage while you were revising it — my
    change was old → new; apply that intent to the current text." The agent
    re-reads the file and merges semantically.
- **Write race**: stat immediately before the handoff write; if mtime moved,
  re-rebase once.
- Comments need nothing: they quote their target text, so they survive rewrites
  by construction.

## Build inventory

New:
- Single-column layout (replaces spread).
- Per-block inline editor swap + caret placement from click position.
- Baseline snapshot + hunk computation + margin cards + pill.
- `write-markdown-file` IPC path (main currently only reads/stats).
- Edit envelope in `markdown-annotations.js`; instruction template + override.
- Rebase-at-handoff (anchor relocation reuses `resolveChangeRecordAnchor`-style
  matching).
- First-key mode dispatch (letters keep today's comment path; every other
  key routes to the block editor at the click caret).

Reused as-is: block anchoring/source map, comment composer and envelope
vocabulary, batch queue concept, PTY injection path, stat-gated polling,
line-diff and change-record machinery, scroll preservation.

## Sequencing (revised 2026-07-11; layout and highlighting shipped)

Unify by layer, not all at once. The contract (`~/agent-threads/contract.md`) is
already shared and keeps parallel UIs from diverging semantically. The store
plumbing is shared from day one — main's store IO (atomic write, per-path
lock, sole-writer) is proven utility reused as-is, not a new abstraction.
The UI is built md-first and unified last: a shared thread-card module
designed now would abstract from one real implementation plus a paper
design — wrong seams. comment-ui.js is the precedent: share after two real
uses prove the shape.

1. Store plumbing: generalize the store IO filename guard to the md sidecar;
   create-on-first-thread; schema with the turn clock.
2. Comment threads round-trip: the comment gesture writes a thread instead
   of an inline envelope; pointer send with the fail-fast runbook check;
   validate end to end with a live agent. — DONE, validated 2026-07-11 in a
   two-round cold run by a different vendor's CLI at low effort: turn clock,
   open counts, both anchor shapes, titles, snippet updates, append-only,
   reply-without-edit, one-line hand-backs all correct; it even verified a
   factual comment against the codebase before editing. Known lenience:
   the read-stamp is skipped by fast single-pass agents, and agent `ts` may
   be fabricated (nothing load-bearing reads ts; ordering is `turn`).
3. Thread rendering in the md viewer: inline cards, disclosure lines,
   turn-clock collapse. Validate in daily reading.
4. Editing core: first-key dispatch, block editor, pending batch, handoff
   with conflict rebase — edits land as threads in the proven pipeline.
5. Unification pass: extract the shared thread-card renderer and collapse
   rule (comment-ui pattern); port the review viewer onto them — review
   gains titles and the turn clock.

Comments precede the editor deliberately: they exercise the entire new
pipeline (store, pointer, protocol, rendering, collapse) with zero editor
complexity.

Steps 1-4 are done and validated. Next, in order:

6. **Edit on rendered text** — SHIPPED 2026-07-11 pm. Mappable blocks
   (paragraphs, headings — the same whitespace-elastic precondition as
   in-place decoration) edit directly on the typeset text via
   contenteditable; markup-heavy blocks keep the source textarea as the
   honest fallback. The entry key acts at the click caret; from there
   the browser owns typing (IME included). Write-back runs the
   decoration mapping in reverse (wsProfile), preserving untouched
   soft-wrap points and the heading marker. Enter or clicking away
   commits; Esc reverts (Esc now cancels the innermost active thing
   before the band may hide). Plain text only: paste is text-only;
   rich/structural inputs and ⌘B/I/U are blocked. v1 notes: no live
   in-block diff while typing (the diff appears typeset in place on
   commit); edits at multiple spots in one session merge into one
   region, so soft wraps inside it become spaces (markdown-identical,
   larger hunk than intent — revisit if agent diffs get noisy).
   Validated headless (36 jsdom checks) and in the real app (native
   typing, Esc, fallback, disk write-back).
7. Change-bar falloff on the turn clock (below).
8. The agent-threads enumeration tool (two-sided clock; enumeration
   advances the baseline).
9. Unification pass with the review viewer (step 5 above).

## Pending actions: active shows, resting folds (2026-07-11 pm)

One grammar for every pending thing, edit or comment: the ACTIVE thing
shows its actions; the RESTING thing is minimal; a click resurrects.

Clicking a block holds the click position and now surfaces it as a
blinking caret in the reading ink, so the edit start point is visible
before you type (letters still comment; the caret marks where any other
key begins the edit). It is an empty span between text nodes — no text,
so it never perturbs offsets or search — and lives only while the block
is the active target, cleared when the target clears or editing opens.

While an edit is live, a small pill is pinned to the active pane's
corner — a labeled `Send ⌘↩` (`Ctrl↩` off-mac) plus a `↶` undo (the same
glyph the resting mark carries; see the glyph rule below). It is
pinned (absolute in the pane), NOT inline after the block: the pane's
`overflow: hidden` clipped the inline strip whenever the edited block
sat near the pane bottom, so the indicator vanished exactly when it was
needed. Its presence is itself the "you are editing" indicator, and the
labeled Send both indicates and finishes the turn. The affordance teaches at the moment attention is on
the edit, so the committed state needs no standing chrome.

Committed edits rest as the decoration alone — the amber marks are the
indicator; going back to a pending edit is the rare act and pays one
click. Clicking any change mark — struck OR inserted — expands the
action strip under that block; clicking the block's live text edits
again; clicking elsewhere folds. Contention resolved this way by
decision (2026-07-12): the marks are the uniform handle so every edit
(including a pure insertion) is reachable for undo/note, and a
word-edit leaves ample live text to re-edit from; the cost is you
click adjacent live text rather than into your own insertion to keep
typing. A hunk with a note leaves a small `❝` mark so the note cannot
silently vanish. The source box follows the same rule (click the box
for its actions).

Open refinement: a SELECTION comment's `❝` mark lands after the whole
block, which for a long wrapped paragraph is far from the highlighted
selection (the yellow highlight is the near signal; the mark is only
the reopen handle). Anchor the mark to the selection's line if the
disconnect bites in daily use.

Queued comments follow the same grammar: the composing card is the
active state; clicked away, the draft rests as a small `❝` after its
block (hover reads it back), and clicking the mark reopens the composer
— where editing, sending, and discarding live. Click-away commits
what's in the box: text queues, empty discards (emptying a reopened
draft IS the delete; the mark carries no ✕). Esc restores instead.

Change vocabulary is track-changes: deleted text is struck through
(rose), inserted text is a colored underline (amber), NOT a solid fill
— a fill collided with the comment selection highlight (yellow), so an
insertion read as a comment. Underline vs solid fill keeps edit and
comment unmistakable. The `❝` marks (queued comment, edit note) are
small amber pills, not bare glyphs, so they read as controls rather
than a quote character in the prose.

The strip's actions are glyphs with hover explanations — long-term
chrome must not contend with the document's own words (the collapse-
glyph rule): `❝` note, `↶` undo, `⌘↩` send. `↶` also serves the live
pill's take-back (above): whether the edit is still in-progress or
already committed, the user sees one revert glyph with one outcome. (An
earlier `✕`/`↶` split named discard-draft vs revert-applied as different
acts — a maker's distinction the user doesn't share.) The sent chip
("sent · awaiting agent") stays words for now — a status, not an action.

## Change bars for agent-change age (2026-07-11 pm)

The green gutter bars were never removed — what we dropped was the
multi-shade age palette (unreadable as a code). Current mechanics: every
observed agent refresh diffs old vs new doc; changed blocks get the
single-shade green bar plus a ~9s pulse; hover reveals the exact changed
ranges; a deletion marks both flanking blocks. A bar batch ages by one
per subsequent observed refresh and falls off after two — falloff is
wall-time-free but keyed to the agent's write cadence.

Decision: keep the bars (threads mark the conversation; bars mark
unreviewed agent deltas — for a large multi-block agent change they are
the cheap what-moved scan) and move falloff to the logical clock for
the same reason collapse lives there: batches accumulate across any
number of agent writes and shift one level older on the user's next
send-batch (the turn tick is the "I acted on this state" signal), not
after N further writes that may land before the user ever looked.

Age shows as three levels. At 3px the hue barely reads, so lightness
carries the age: it climbs in even steps (L 33 → 58 → 78) while
saturation drops (68 → 40 → 32), keeping a fresher bar the louder one.
The hue nudges enough that each level is nameable too: this turn
`#1b8d4c` (green) → one send ago `#69bfa2` (sea-green) → two sends ago
`#b5d9d0` (mint, almost page), then gone. One green family that fades
into the page; amber stays pending, slate sent, rose deletion, blue
links. Tuned for normal vision by decision (2026-07-11): CVD users
customize the ramp later.

Earlier cut A (green → teal → grey-green) receded hue and intensity
together but read as unrelated colors — its teal was as loud as its
green, so the fade broke. B (single green, lightness only) read cleanly
but flat. Green ladder+ keeps B's even lightness ladder and adds a
nameable hue per step; chosen against variants at real 3px on both band
grounds (2026-07-12).

## Runbook missing: send anyway (2026-07-12)

The shared runbook resolver walks nearest-first up the governed document's
direct ancestor chain, then checks inside the session's current git repo,
beside that repo, then `$HOME`. The repo fallbacks support both layouts for an
agent-related repository: vendored (`product/agent-threads/`) or sibling
(`product/` beside `agent-threads/`). Stable deduplication prevents a fallback
copy from overriding the same path found nearer. If every candidate is
missing, the send preflights before writing anything and presents a native
"Send anyway / Cancel" dialog. Send anyway pastes the pointer without the `per
{runbook}` clause (the agent works from the store alone); Cancel leaves the
document and store untouched. The ack is never cached — every send re-scans,
so a later checkout/vendor is picked up and a still-missing runbook prompts again.
Preflight precedes the document write so Cancel is truly a no-op.

## Resting annotation row (2026-07-12)

A comment and an edit's note rest as the same thing: one low-profile
bordered line, no fill (a fill reads as an inserted code/callout block).
Detail and actions reveal on click. The left-accent carries type — slate
comment, green edit note, amber unsent draft — and the text truncates to
the line. This unifies what were two heavier forms: the comment thread card
and the boxed source-diff.

- **Comments default to the row.** `isThreadCollapsed` flipped: a thread
  rests collapsed and expands only while the agent's newest reply is fresh
  (its turn ≥ the store turn, i.e. before the user's next send), or on an
  explicit click. The card is the click-revealed detail, not the resting
  state.
- **An edit shows only its note.** The change itself is already in place
  (struck/inserted text, inline or block-level), so the row doesn't re-show
  the diff — it carries the note, the one thing not otherwise visible. No
  note, no row: the decoration is the whole resting mark, and clicking the
  struck text reveals the strip (which offers add-note / undo / send).
- **Non-mappable edits render as block-level track changes in place** — a
  removed line/chunk stays typeset and struck (rose) where it was, a
  replacement's new lines follow marked (amber underline), until the agent
  accepts and it vanishes. No box, no row: the strike/underline is the
  resting mark, the whole ghost is the click handle for the strip. This is
  the word-level strike/insert idiom raised to the line/block granularity,
  so a whole-line delete reads the same as a deleted word. Large structural
  rewrites are rare on this surface by design — they go to the agent as a
  high-level comment — so the multi-line ghost stays a light fallback.
- **A note is the only thing that gets a standing row** (amber). Every
  edit's own resting mark lives in place; a deletion marks the text struck,
  never a separate line.
- Fixing this surfaced a latent bug: Space in a band composer page-flipped
  instead of typing (the doc-level flip handler didn't exclude focused
  fields), so notes and replies silently lost their spaces. The flip guard
  now skips editable targets.

## The frozen-document suggestion model (2026-07-12)

The target the cases above converge on: direct editing is a suggestion
overlay on a document whose structure never changes. One rule — you mark,
the agent restructures.

- **Delete = strike in place.** Removed characters stay visible, struck
  (rose), until the agent accepts. Striking a whole block is how you say
  "remove this block": the block stays present and fully struck, so nothing
  empties or vanishes mid-edit.
- **Insert = mark in place.** New characters show marked (amber underline),
  inline.
- **Structure is immutable.** No structural gestures — split, merge, retype a
  paragraph as a heading, add a block. Those are creative changes the agent
  makes from a high-level comment. Content deletes/inserts apply directly, and
  a fully-struck block materializes as a real removal (its lines dropped), so
  no empty block, all-spaces line, or empty heading ever reaches disk or the
  agent — it never has to keep a placeholder char.
- **Representation is the crux** (the choice that makes the above hold): a
  change is marks over the frozen original, turned into text only at send. A
  rewritten source that gets re-rendered empties a fully-struck block and makes
  it vanish; overlay-on-original cannot hit that edge.

Status: the fully-struck-block edge is closed (it strikes in place). The full
inversion — render the pending view from the baseline and overlay every edit's
marks, retiring the working-source diff/ghost machinery for one strike/insert
path — is the remaining refactor. A live strike-on-delete editing surface (vs
today's free-edit-then-decorate) is optional polish on top.

## One composer for edits and comments (2026-07-13)

An edit is another form of comment, so it wears the comment's chrome. A comment's
body is its text; an edit's body is its in-place diff, so the same textarea
carries the comment's body for a comment and the edit's optional note for an
edit. The apparatus is `createComposer` inside the comment-card bubble, with Undo
and Send where a comment has Cancel and Send.

The control is **one thing across the edit's whole life** — the same bubble while
you make the edit and when you revisit it. Editing a block shows the bubble inline
under it (note field + Undo + Send); the edit commits only when focus leaves the
whole apparatus (block + bubble), so you can move between the text, the note, and
the buttons freely. A note typed while editing rides onto the committed hunk (by
line span) and surfaces as the resting note row. There is no separate floating
live-edit pill.

- **Resting:** every annotation rests with one bordered line, for full
  consistency. A comment carries its first line; an edit carries its note; a bare
  edit shows a muted "Add a note" prompt — still a standing, discoverable handle
  to its control, and honest (it shows the empty note slot, never re-shows the
  diff). All are first-line, whitespace-collapsed, ellipsis-trimmed the same way.
  (This retires the earlier "no note, no row" rule: an edit's in-place diff is its
  content, the resting line is the consistent handle on top.)
- **Attended (making or revisiting):** the same composer bubble; the note is the
  textarea, saved live as you type.
- The old two-step glyph strip (❝ to add a note, then a separate composer) and
  the floating pill are both retired — the composer is the control.

The requirement difference the design leans on: an edit's content is in the
document (its marks paginate like text), so only its **controls** float freely; a
comment's and a note's content lives nowhere else, so it is **content** that must
stay anchored and visible. Open: near a page's bottom edge the inline bubble and a
comment mark still clip (the spill). Controls may float; content must stay
visible — the spill fix should keep content spill-safe, not chase pill/inline
symmetry.

## Edits and comments coexist on a block (2026-07-13)

An edit and a comment on the same block now work together: the edit decorates in
place, the comment rests as its mark below, and the edit stays rollback-able.
The bug was that `layoutSpread` freezes whenever a comment is queued (its
`innerHTML` rebuild would wipe the queued marks), so committing or revealing an
edit on a commented block never rendered — the change landed as plain text with
no decoration, sendable but neither shown nor undoable. `relayoutThroughQueued­
Comments` rebuilds anyway and re-anchors each queued mark onto the fresh DOM by
its stable `anchorId`; the edit commit/revert path and the strip toggle both use
it. Queued marks re-anchoring by id is the same move the review viewer uses for
orphaned comment threads.

## In-place decoration for markup lines (2026-07-13)

A user edit is a **known, per-block change**, tracked as such — not rediscovered
by a source line-diff (that is reconciliation's job, for the black-box case of
the agent rewriting the file). The block's rendered text before any edit is
captured **in context** at edit time (`state.editRendered`, keyed by the block's
current source, first-original-wins across re-edits). Decoration diffs that
captured original against the live block and strikes/inserts in place — precise
by construction, single-block by construction. So deleting one word strikes just
that word, even on a `code`-bearing line (the code keeps rendering as code), and
even in a list item where a reconstructed re-render slipped and over-struck the
whole phrase. The source stays only for the agent envelope; reconciliation keeps
its own line-diff + change bars, unshared.

The del/ins the user sees is the natural form of the record (strike = delete,
mark = insert, replace = both). It's derived once from that single captured-vs-
live diff rather than tracked keystroke-by-keystroke: a live strike-on-delete
surface would be exact on intent but a much bigger build, and it can't work for
the markup path at all (a `<textarea>` can't carry inline marks), so the derived
diff is the uniform, simpler model. Falls back to re-rendering the reverse-
applied block only when no capture exists (e.g. an external change). Trailing
whitespace is normalized (a detached render ends in a newline the live block
trims). The ghost remains only for what genuinely can't map to one block:
multi-block spans, whole-block deletions, and pure-syntax edits.

## Strike-in-place editing (2026-07-13)

The rendered editor now edits by striking, not removing: `beforeinput` is
intercepted so a delete wraps the target in `<del>` (never removing it), a
keystroke inserts marked `<ins>`, deleting your own insertion removes it, and a
selection-delete strikes the whole selection. Structure can't change — no new
blocks, no cross-block deletes. This is the "edit is a comment" model made
literal (validated first as a standalone prototype): the marks *are* the edit,
so there's no diff to derive and nothing to reconstruct — the source of the
imprecise `s<del>ingle s</del>ource` boundary.

The exact marks survive commit via an **overlay**: on commit the block's marked
inner HTML is snapshot (`state.blockOverlays`, keyed by the block's new source)
and re-applied verbatim on every render, overriding the captured-original diff
path. So a struck `single ` stays `single `, not a re-derived boundary. The
working source and hunks still drive send and refresh-gating; only the
decoration is now the overlay. Programmatic / source-textarea edits with no marks
fall back to the diff path (which is why the jsdom tests, which set `textContent`
directly, stay green).

The agent envelope now ships the **exact marks** too. A strike-in-place edit's
`[Edit]` body is the block's overlay in rendered form — the passage with
`<del>`/`<ins>` where you struck/added, markup tags dropped — so it reads
`<del>single </del>source` rather than the re-derived `s<del>ingle s</del>ource`.
The user marks intent on what they see; the agent maps it to the source and
decides how it lands (edit is a comment, the agent interprets). Without an
overlay (a source-textarea or programmatic edit) it falls back to the derived
source diff. The runbook (`agent-threads/md/user-intent.md`) is updated to match: the
marks are over rendered text, the edit is not pre-applied, apply it to source.

The spill has a first fix: when an active edit control (live or revealed) sits
below the fold of the primary page, `ensureVisibleInPane` scrolls it into view —
controls may float, but this content stays visible. Scoped to the primary page
(the secondary is transform-positioned); resting marks near a page edge still
wait for the flip.

Still remaining: the secondary-page / resting-mark side of the spill. (The
working-source/diff path has since been retired — see the freeze-source section
below.)

## Turn, lock, and verbatim markers (2026-07-14)

A thread marker's color now carries *whose turn it is*, derived from `status`:
the agent's turn (an un-answered thread) is amber, the user's turn (the agent
has replied) is green. Type is read from the block, not the color. A sent,
un-answered edit seals its block with an amber border, and in-place editing is
disabled there — a note or comment still routes through its own path, so only
re-mutating the submitted suggestion is blocked (roll back to change). The
border is the whole lock signal; the "sent · awaiting agent" chip is gone.

Markers carry only authored content. Dropped as redundant with color and
position: the type glyph, the "awaiting agent" / "your turn" labels, the
"Agent:" author prefix, and quotes around a user comment. The viewer places and
colors authored text and synthesizes nothing: an un-answered edit shows no
marker line (the sealed block represents it), and replies render verbatim.

Enumeration follows: the agent is handed the un-answered set (`status` not
`answered`) each round rather than a since-baseline cursor. The turn clock stays
for viewer-side collapse and change-bar aging only.

Still to build: gating a sealed block against a disk refresh until its edit is
answered; the resolve transition (reply unseals, the block morphs to the agent's
text with the change highlight); turn-coloring the answered-edit collapsed line
and the expanded card; and the host-side un-answered enumeration.

## Freeze-source inversion (2026-07-14)

The source is now frozen: a user edit never mutates `sourceText`, and the marked
overlay is the single truth for both decoration and the `[Edit]` envelope. The
parallel diff machinery is gone — `workingSource`/`pendingBaseline`, the
line-diff hunks (`computePendingHunks`), the rendered→source splice
(`spliceRenderedEditIntoSource`, the source-corruption source), the captured
`editRendered` map, the track-changes ghost, and the whole-doc
`rerenderFromWorkingSource` all retired. `blockOverlays` is re-keyed by the
block's stable `data-md-anchor-id` (`{ html, note }`); decoration and the
envelope both enumerate it directly. Commit, undo, the refresh-freeze gate, the
send gate, and the pending count all key on `blockOverlays.size`.

The payoff the user asked for: **editing is limited to commenting-like**, so
markup blocks strike in place like prose — the raw-source `<textarea>` fallback
(and `canEditRendered`) is deleted; striking a word inside `**bold**` leaves a
`<del>` inside the rendered `<strong>`, and `overlayToEnvelope` ships
`<del>bold</del>` with no `**` (the agent maps rendered marks to source). Because
nothing splices into source, the earlier corruption (rendered-text-minus-markdown
written back) is impossible by construction. Verified: 74 jsdom checks, plus
real-app drives confirming markup strike-in-place with the in-memory source
intact, and the seal/turn/resolve lifecycle unchanged.

## Layout and persistence decisions (2026-07-14)

**Layout stays the two-page book-spread.** Both columns are the document (page
N | page N+1), advanced by whole page-flips. A "turn column" — the second column
holding pending edits / agent replies / activity instead of a second document
page — was weighed and declined: the current two-page read is better. Annotations
live inline, anchored to their blocks, not in a side rail.

**A block reads the same with or without an annotation.** Annotations rest
lightly — struck/inserted marks in place, a slim note line, a one-line collapsed
thread — and never restructure the page. The no-annotation and has-annotation
states should look the same or nearly so: a resting annotation is a small mark,
not a card that pushes the prose around (cards show only briefly for a fresh
reply, then collapse).

**Persistence is persist-on-send; there are no unsent drafts to lose.** The .md
is never written (an edit is a comment). Pending edits and comments live in
memory; the UX encourages sending rather than hoarding drafts — the primary
action on an edit's control (and ⌘↩) is Send, which flushes *all* pending edits
and comments to the sidecar store in one batch, and each send persists there. So
no separate crash-safe-draft mechanism is built: sending is the persistence, and
it is the default next step after an edit or comment.

## Edit instead: comment → edit switch (2026-08-30)

The dispatch's accepted cost bites a specific reflex: select, type, and the
hand meant to type over the selection, as in every editor. The letter opened a
comment card instead. Backing out and redoing it as ⌫-then-type is three
gestures for a one-gesture intent.

The recovery is one chord inside the composer: ⌘E (Ctrl+E off Mac) converts
the card to an edit. Whatever the card holds is the replacement — the block
editor opens with the selection struck and the card's text inserted after it,
exactly the marks the same keystrokes would have left had the first one been an
editing key. A block-click target inserts at the held click caret. An emptied
card converts too: the editor opens with the selection back live, ready to be
typed over. The card also carries the action as a button ("Edit instead ⌘E"),
its chord shown, since nothing else would teach it.

Only fresh cards convert. A revisited queued comment is a comment; it keeps
Discard as its only destructive exit. A block the editor refuses (sealed,
image-only) keeps the card and its text and toasts the same line the editor
would.

Mechanics: the target and its selection record stay armed across the card's
close, and `openBlockEditor` takes the card text as `entryText`, entering
through the same strike-then-insert path as a printable entry key. The live
DOM selection is gone by then (Chromium collapses it into the focused
textarea), so the switch works from the armed record's offsets — the same
fallback a virtual-drag selection uses.

## Open questions

- Default wording of the instruction template (tune against real agent behavior).

Resolved by the freeze-source inversion: rendered→source caret mapping and hunk
grouping no longer exist — markup edits in place on the rendered text, and there
are no line-diff hunks.
