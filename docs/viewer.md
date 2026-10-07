# Open a viewer

The viewer band sits above the prompt and shows what you are working on: the agent's markdown docs and its reviews ([edit](plan.md) and [comment](comment.md)), plus images, video, audio, PDFs, and local pages. It is part of the terminal, so it expands and hides on its own.

## Open something

Clicking what the agent prints is the usual way in ([what a click does](clicks.md)). `Ctrl/Cmd+Shift+U` opens one without a click: a list of what you opened and what the session has shown, filtered as you type.

Typing also reaches past the session: type a name and nearby files are searched as well, the repo's first, so a file the session never showed can still be opened.

## Find your way around

Markdown opens as a rendered document, with two pages side by side that turn rather than scroll. A curated review has its own navigation for moving among the agent's explanation and the files it wants you to inspect.

Both support the [shared commenting workflow](comment.md), alongside commenting on terminal output. See [planning](plan.md) for writing in rendered markdown and [the curated review](review.md) for reviewing the agent's changes.

## Links and unsent work

Links behave differently in documents, reviews, and ordinary web pages; [what a click does](clicks.md#inside-viewers) covers where they take you.

In markdown, if you have a comment, reply or edit waiting to send, following a file link is blocked until you send or discard it; then follow the link again. Web links leave the markdown document open while you visit the browser.

## Hide or resize

`Ctrl/Cmd+Shift+O` hides the band and shows it again; `Ctrl/Cmd+Shift+I` switches between full size and a split with the terminal.

On its own, the band comes up full when the agent changes what it shows, splits when you send so you can watch the agent pick up, and hides when you type or click in the terminal. A band you hide yourself, a click in the terminal included, stays hidden through the agent's changes until you next type there.
