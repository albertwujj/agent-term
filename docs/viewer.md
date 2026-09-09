# Open a viewer

The viewer band sits above the prompt and shows what you are working on: the agent's markdown docs and its reviews ([edit](plan.md) and [comment](comment.md)), plus images, video, audio, PDFs, and local pages. It is part of the terminal, so it expands and hides on its own.

## Open something

Clicking what the agent prints is the usual way in ([what a click does](clicks.md)). `Ctrl/Cmd+Shift+U` opens one without a click. The list starts with what you opened, most recent first, so the top row is where you came from and the rows under it are the steps before that. Everything else the session has shown follows, and typing filters the list.

Typing also reaches past the session. A long session scrolls its early work away, a resumed one comes back with only part of its transcript, and a file the agent never mentioned was never in the list at all. Type a name and nearby files are searched as well, so you can still open it. The repo's files come before its neighbours', most recently changed first, and each row shows how long ago that was.

## Find your way around

Markdown opens as a rendered document, with two pages side by side. With focus in the document, `PageDown` and `PageUp` turn the pages. A curated review has its own navigation for moving among the agent's explanation and the files it wants you to inspect.

Both support the [shared commenting workflow](comment.md), alongside commenting on terminal output. See [planning](plan.md) for writing in rendered markdown and [the curated review](review.md) for reviewing the agent's changes.

## Links and unsent work

Links behave differently in documents, reviews, and ordinary web pages; [what a click does](clicks.md#inside-viewers) covers where they take you.

In markdown, if you have a new comment or edit waiting to send, following a file link is blocked. A brief message says “Send or discard your changes to follow that link.” Send or discard the pending work, then follow the link again; it will not open automatically. Web links leave the markdown document open while you visit the browser.

For now, send draft replies in existing comment threads before switching documents; the link warning does not protect those drafts.

## Hide or resize

`Ctrl/Cmd+Shift+O` hides the band and shows it again; `Ctrl/Cmd+Shift+I` switches between its two sizes. In markdown, `Esc` first backs out of the current comment, edit, or selection; when none is active, it hides the band. Use the hide shortcut to get the document out of the way without cancelling an open comment or edit.
