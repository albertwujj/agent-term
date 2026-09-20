# Comment on the agent's output

<p align="center">
<img src="assets/comment-brainstorm.png" alt="select a claim in the agent's brainstorm and ask, right on the output">
<br><sub>Select anything on screen and comment</sub>
</p>

Select the passage, then write your note: precise feedback, with the exact text quoted. Commenting works across **terminal output, markdown documents, and curated reviews**: your note goes to the agent tied to the passage or code line you are responding to, without copying it into the prompt yourself.

![the sent message carries the quoted selection, and the agent acts on it](assets/comment-sent-brainstorm.png)

## Choose what to comment on

The best way to get familiar is to try it. In the terminal, a double-click selects a word and a triple-click a line; in a document, a click sets the comment on a block. Drag-select when you need exactly the words you mean. Then type your note.

## Edit the text

You can edit a [rendered plan](plan.md) or a [review's commit message](review.md) directly. The agent takes the edit as your intent; a note, if you attach one, makes the intent clearer.

## Send now, or collect and send

Send a note at once, or move on to the next passage without sending: the notes and edits accumulate and go in the next send, and you can revise them until then.

## Useful details

To comment on a terminal link that opens upon click, drag-select its text ([what a click does](clicks.md)).

If a CLI's full-screen display prevents selection, hold `Shift` while selecting ([how a CLI draws](dev/cli-rendering.md)).
