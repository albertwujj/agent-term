# Pending work

Highest-level view of what's left on the md-viewer editing/threads work and
around it. Detail and rationale live in `md-editing-design.md`; this file is
the map. Updated 2026-07-12.

## Next up (planned build order)

1. **Selfreview enumeration tool** (two-sided turn clock). A verb the agent
   runs to enumerate messages with `turn > agent_seen_turn`, which advances
   the baseline to the store turn in the same pass (one verb, no separate
   `--advance`). The viewer then consumes `agent_seen_turn` as a second
   "consumed" signal (alongside "the agent replied") to clear sent diffs.
   Runbook references the tool once it exists. This is the immediate next item.

2. **Unification pass with the review viewer** (design steps 5/9). Extract the
   shared thread-card renderer + collapse rule (comment-ui.js precedent: share
   after two real uses), then port the review viewer onto them. Review gains
   titles and the turn clock; `resolve` is expected to retire.

## Deferred UX refinements

Small, only if daily use snags on them.

- Selection-comment `❝` mark lands at the block end, far from the highlighted
  selection in a long wrapped paragraph. Anchor it to the selection's line if
  the disconnect bites.
- The `sent · awaiting agent` chip stays words; could quiet to a glyph like the
  strip actions if it earns it.
- The `↩ done` in-edit hint appears every edit; consider fading it once learned.
- Multi-spot edits in one block merge into one region on write-back, so soft
  wraps inside it become spaces (markdown-identical, a larger hunk than intent).
  Revisit if agent-facing diffs get noisy.

## Open design questions

- Where annotations live on wide windows: margin cards (Google-Docs shaped) vs a
  second column whose job is the *turn* (pending cards, agent activity,
  reconciliation). Prototype both when building the pending-batch UI.
- Whether the unsent pending batch persists in the sidecar (crash-safe drafts,
  no keep-or-discard prompt on close) or only sent exchanges do.
- Hunk grouping threshold (how many unchanged lines separate two hunks).
- Instruction/pointer template wording, tuned against real agent behavior.

## Deferred design items

Named in the design record, not yet scheduled.

- Comment on a dirty (already-edited) block as a nested `[Note]`.
- Deviation highlighting: the agent's result vs what the user submitted.
- Viewer stamping `anchor_status` write-back.
- Archival of old folded threads.

## Separate track

- Streaming: source-side client that streams sessions to a hub on the Mac mini
  for remote viewing. Spec/schema/roadmap in `../agent-stream-hub/stream.md`
  (see CLAUDE.md).

## Recently shipped (context)

Store plumbing, comment-thread round-trip (cold-agent validated), thread
rendering with turn-clock collapse, the editing core, edit-on-rendered-text,
change bars aging on the turn clock, the pending-actions grammar (active shows /
resting folds), track-changes vocabulary (strike/underline), minimal word diff,
the click caret, the runbook "send anyway" escape hatch, generic closest-wins
runbook resolution for current-repo vendored/sibling layouts, and one-shot
relaunches that normalize the inherited marker, rebuild every runtime bundle,
route through the latest installed/portable launcher, and immediately retire
the predecessor.
