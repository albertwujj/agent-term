# Comment on the agent's output

![select a claim in the agent's brainstorm and ask, right on the output](assets/comment-brainstorm.png)

Point at what you mean, then write your note: precise feedback, with the exact text quoted. Commenting works across **terminal output, markdown documents, and curated reviews**: your note goes to the agent tied to the passage or code line you are responding to, without copying it into the prompt yourself.

A comment explains what you want changed; [an edit proposes the wording](plan.md). You can optionally attach a note to an edit to explain why. Both convey your intent to the agent, which updates the source.

## Choose what to comment on

| Where | What you can comment on |
|---|---|
| Terminal output | Any selected word, line, or passage. |
| Markdown viewer | Whole blocks or selected text, including sentences (triple-click in prose) and passages spanning pages. |
| Review prose, commit message, or in-place rendered markdown diff | Whole blocks or selected text. |
| Review code or source diff with line numbers | Individual source lines. |

Then type your note.

![the sent message carries the quoted selection, and the agent acts on it](assets/comment-sent-brainstorm.png)

## Collect and send

Collect notes on several passages and send them as one batch. **To prompt** lets you combine that feedback with an overall instruction before sending it to the agent. In markdown, text edits can travel in the same batch.

Drafts stay attached to what you commented on; documents and reviews keep the agent's replies in the same thread. Before switching documents, see [links and unsent work](viewer.md#links-and-unsent-work) for draft protection and its limits.

## Useful details

In the terminal, `Esc` clears a selection so typing reaches the shell again.

To comment on a terminal link that opens immediately, drag-select its text ([what a click does](clicks.md)).

If a CLI's full-screen display prevents selection, hold `Shift` while selecting ([how a CLI draws](dev/cli-rendering.md)).

See [the curated review](review.md) for the review loop, or [open a viewer](viewer.md) to get to a document or review from the terminal.
