# Plan with it

![the plan loop: type raw lines into the rendered doc, send, and the agent shapes them into a heading and list](assets/doc-edit-loop.gif)

The viewer turns markdown into a place you write English. A doc opens rendered and shows both your proposals and how the agent takes them forward: you comment on any passage or edit the rendered text directly, and the agent processes and polishes. You write in the preview, never touching raw markdown or switching edit/preview modes, and the agent maintains the source.

And English is where the real planning happens: much of a design is settled in words before any code. A plan converges here the way code does: commented, revised in place, settled before anything is built. The same loop covers any writing project (essays, notes, research), with your materials organized as a repo the agent edits for you.

Editing goes beyond word swaps: start new lines anywhere in the rendered page, and the agent decides what each becomes in the source (a heading, a list item, a paragraph). Your edits reach it as suggestions; it applies the intent.

![a long changed paragraph: a bar in the margin marks the block, and hovering shows the exact words that changed](assets/change-highlight.png)

You can also see what the agent changed. A bar in the margin marks each block it edited. Hover one and the exact words show, green for added text and blue beside a deletion, which is what you want when the block is long and only a few words changed. The bars fade over your next few sends.

When a draft is ready to go out, one button copies it, or just the section under a heading, as plain text for Teams or email, or as markdown for GitHub ([copy a doc into a message](copy.md)).

The loop runs on [agent-threads](https://github.com/albertwujj/agent-threads)'s instruction docs (`md/user-intent.md` and the shared `contract.md`); the terminal points the agent at them with each send. Where the clone can live: [placement](conventions.md#placement).
