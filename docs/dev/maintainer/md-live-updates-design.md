# The agent's writes while you work

The agent writes the open document and its reply journal while you read,
comment and edit. Two goals pull against each other:

1. **Show the agent's latest content and replies as soon as they land.**
2. **Never disturb what you are in the middle of:** the text you are typing,
   the passage you are commenting on, and the words under your cursor.

This doc records how the markdown viewer balances them, what that costs, and
what is left. Editing's own reconciliation lives in
[md-editing-design.md](md-editing-design.md) (Conflicts).
The contribution records and their storage are described in
[thread-history-design.md](thread-history-design.md).

## Where this came from (2026-10-13)

A block on the left page flashed green right after a comment was sent on the
right page. The agent had rewritten that block four minutes earlier, 12 seconds
after the comment composer opened. The open composer held the refresh. Once
the band's arrival flash ended, nothing said the page was stale. The Send
released the edit with its pulse, so the flash looked like the Send's doing.

## Why anything is held

Every render rebuilds both article copies (`layoutSpread` sets `innerHTML`).
Whatever lives in that DOM is destroyed by a render unless it is carried
across: an open composer or reply, the in-place editor, queued marks, the
armed block's caret, and sent-edit seals. Block ids (`md-a-N`) count blocks
from the top, so every id below shifts when the agent adds or removes a
block. Pending edits are marks over a frozen snapshot that reconcile once,
at Send.

A write is all or nothing: the viewer either renders the new document or
keeps the old one.

## What the page does now

| You have | The agent's write | Why |
|---|---|---|
| Nothing in hand | Lands with the change pulse and bar | |
| A clicked block, no key yet | Lands; the block re-arms with its caret or selection | A rebuild used to drop the armed block, so the first key went nowhere |
| …and the agent rewrote that block | Lands; the block disarms | The click pointed at text that is gone |
| An open composer or reply | Held until it closes or sends | The render would destroy the card under your typing |
| The in-place editor or unsent edits | Held until Send | Edits reconcile once, at Send |
| A queued comment, its block untouched | Lands; the mark moves to the block's new id | `mapIntactAnchors` |
| …or rewritten in place | Lands; the mark moves to the rewrite | `findReplacementAnchor`: one block of the same kind between unchanged neighbours |
| …or a selection whose words survive | Lands; the highlight follows the words, wherever the lines now wrap | |
| A queued comment with nowhere to sit | Held until Send or discard | Its block was deleted, split or merged, its selected words are gone, or a passage across blocks changed |

Around those rules:

- **A held write is marked.** The bar keeps the unseen hue a rolled-up band
  shows (`vb-unseen`) until the write renders and its change has been on
  screen. A queued comment that holds a write carries the note "agent
  updated · reconciles on send" on its mark. That is the note a held edit
  shows in its strip.
- **Replies wait with the document.** The thread layer renders from the store
  and the document together. If the store went ahead of a held document, a
  thread resolved over its edit would drop the seal from the old text, and
  the edit would seem to vanish. Thread renders also wait while a composer is
  open or a block is armed.
- **Send lands what it held at once,** as the agent's earlier work under the
  receipt (`pendingRefreshBeforeSend`), not as the agent's answer.
- **A pulse resumes across a rebuild.** Otherwise a Send seconds after a
  change landed would restart the pulse, and the change would look like the
  Send's doing again.
- **A carried comment quotes the page as it now reads.** Send quotes the
  rewritten block, which is the text you saw when you sent it.

## Downsides and trade-offs taken

- **One holder holds everything.** A write is all or nothing, so one open
  composer or one homeless queued comment delays every change and reply in
  that write, not just the one it concerns. The hue and the note say so, but
  the page stays behind.
- **You can write against text the agent already replaced.** While a write is
  held you comment on the old text, and the comment goes out quoting it. The
  agent re-reads the document, so it still understands the comment. Still,
  you may spend a comment on wording that no longer exists.
- **A carried mark sits on text it was not written about.** When the agent
  rewrites a block under a queued comment, the mark moves to the rewrite. The
  change pulse and bar say the block changed under the draft, but nothing
  stops a Send of a comment that no longer fits. This was accepted because the
  common case is a follow-up queued on a block while the agent answers the
  comment before it. Holding there hid exactly the answer being waited for.
- **Selection comments hold rather than guess.** When the selected words are
  gone, carrying the mark without a highlight was rejected:
  - the comment would read as a block comment;
  - reopening it would grey the whole block;
  - after Send, the thread could not find its quote and would fall back to
    its section heading.

  That is more confusing than a hold. A triple-click sentence comment
  therefore holds every write that rewords its sentence, which is likely when
  the agent rewrites the block.
- **Content moves under you.** A landing write keeps the page top fixed, not
  the place you are looking at. On the two-page spread a block can cross to
  the other page.
- **The block matching is a heuristic.** A rewrite that also changes the
  block's kind, or splits or merges it, finds no replacement and holds.

## Roadmap: updates while typing (not built)

What disturbs typing is the full-page rebuild, not the update itself. Stage
0 (the held cue, queued comments letting other writes through, Send landing
what it held) and stage 1 (carrying a queued comment to a rewrite) shrank the
holds while you are not typing; they are what this doc describes above. The
remaining stages replace the rebuild with changes that leave the typing spot
alone.

First, **log the holds**: record how long writes stay held and by what
(composer, queued comment, edit) in the `renderer-diag` log. A few days of
real use would say which stage is worth the most.

- **Stage 2: keep the typing point fixed.** A helper that holds the open
  composer, reply or editor at the same screen position while content above
  it changes height, replacing the page-top anchor
  (`preserveSpreadTopAcross`). Nothing visible changes on its own; stages 3
  to 5 need it.
- **Stage 3: replies while you type.** Thread rows sit between blocks
  (`renderThreadLayer` removes and re-inserts only them), so a store update
  can render without rebuilding the article, and an open composer survives.
  A seal coming off needs its one block re-rendered. Apply at a pause in
  typing, never during an input method's composition.
- **Stage 4: document writes while you type.** Patch only the changed blocks.
  Whole blocks keep their elements and take their new ids
  (`mapIntactAnchors`), so the composer keeps its block. A write to the block
  you are typing on waits for that block alone.
- **Stage 5: editing.** The same patching, plus remapping unsent edits' ids
  and source ranges. The edited block stays frozen while everything else
  updates. This is last because it touches the rebase at Send, the riskiest
  code here.

Also on the table if selection holds bite: track a sentence through a rewrite
with a word diff of the old block against the new, highlight the rewritten
span, and quote it at Send. It was set aside because a fuzzy mapping can
confuse in its own way.

## Code and tests

- `src/markdown-viewer.js`:
  - `planRefreshThroughQueue`, `seatQueuedComment` and
    `planArmedAcrossRefresh` decide what a write carries and what holds it;
  - `renderHeld` and `hasBlockingMarkdownRefreshState` decide what holds a
    render;
  - `noteRefreshHeld` and `markQueuedHolders` mark a held write.
- `src/markdown-change-diff.js`: `mapIntactAnchors`, `findReplacementAnchor`,
  `unchangedLineShift`.
- `test/markdown-held-refresh.test.js` (jsdom), `test/e2e/md-held-refresh.mjs`
  (the real app), and `test/markdown-change-diff.test.js`.
