# Thread histories: model, storage and possible journals

*2026-10-14. The journal migration below is a proposal, not implemented.*

## The model in the essay

[Files in the terminal](https://yunxin.github.io/rethink-terminal/files-in-terminal/) describes two
separate records of the discussion, one for each partner's contributions.
The viewer records the user's comments and proposals; the agent records its
replies and thread updates. Readers combine both beside the current document.
Sent feedback remains part of the discussion, and follow-ups add to it.

“Record” describes ownership and the retained discussion without prescribing
a file format. The essay and its diagram treat the two contributions alike
at that level. Their current storage differs, as described below.

## Current storage

| Record | Writer | Representation |
|---|---|---|
| `<stem>-comments.json` | The viewer's main process | A JSON snapshot, replaced when the viewer changes its state |
| `<stem>-agent.jsonl` | The agent, through `journal.py` | Append-only events for replies, statuses, titles and anchors |

The snapshot contains user messages, initial anchors and send bookkeeping.
The agent's events remain in the journal; readers apply them at read time,
and never fold them back into the snapshot. Each file has one writer.
Snapshot updates are serialized within main and written through a temporary
file followed by a rename.

When the snapshot changes:

- **Markdown:** a sent batch adds new comments, proposals and follow-ups and
  advances the turn counter. A separately sent follow-up also advances the
  counter. Composing or queuing feedback does not change this file.
- **Code review:** adding pending feedback, revising or discarding an unsent
  item, adding a follow-up or decision confirmation, and retracting an unsent
  confirmation update it. Sending stamps the user messages with their turn.
  Review regeneration can also update anchor positions through main.

Sent messages are preserved. A pending review thread can be replaced or
discarded only while wholly unsent and without agent contributions. A pending
decision confirmation can be withdrawn before it is sent. Changing the snapshot
therefore does not mean rewriting the sent conversation. Reading agent replies
alone does not rewrite it either.

Implementation references: [main.js](../../../src/main.js) owns snapshot
writes; [agent-journal.js](../../../src/agent-journal.js) merges the records;
[the shared contract](https://github.com/albertwujj/agent-threads/blob/main/contract.md)
defines writer ownership and journal use.

## Possible future: two append-only journals

The viewer could also append events, giving both partners the same storage
model. Readers would derive the current discussion from the two journals.
A correction or withdrawal would add an event rather than remove earlier
data. This would make the histories consistent and retain earlier state
changes. The current one-writer separation already prevents the viewer and
agent from replacing each other's file; that benefit does not depend on
this migration.

Work to define before changing storage:

- Viewer events for new threads, follow-ups, sends, anchor adjustments and
  pending review feedback changes. Decide whether unsent review drafts remain
  a separate mutable snapshot or become events too.
- A common read model used by the viewer and agent tools, preserving thread
  IDs, turn semantics, statuses and the rules for revising unsent feedback.
- A migration from existing snapshots that retains all sent messages,
  anchors and turn values, without requiring users to recreate their threads.
- Replay behavior for interrupted writes, repeated reads and old stores;
  validation across both Markdown and code review.

Display timing and preserving a comment's target are separate concerns,
covered in [the live update design](md-live-updates-design.md).
