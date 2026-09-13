# What a click does

Click a reference in terminal output to open it: in the window, your IDE, another application, or your browser.

## In terminal output

**In the window.** Markdown documents, reviews, images, audio, video, PDFs, and local pages open rendered. A diff line on a document jumps to the corresponding passage for commenting or editing.

**Other applications.** Code references (`file:line`, symbols, or code-diff lines) jump to your [IDE](ide.md). Files the viewer cannot display and folders open through the OS. These handoffs wait briefly so you can select for [comment](comment.md) instead; `Ctrl/Cmd`-click skips the pause.

**Web links.** A plain click opens your browser; `Ctrl/Cmd`-click opens the page in the in-window web viewer instead.

## Inside viewers

**Markdown and reviews.** `Ctrl/Cmd`-click follows a link: a file link opens that file in the viewer, a web link opens your browser. A plain click on a link in a markdown document prepares a comment or an edit instead. The review's own navigation links still take plain clicks. See [viewer details](viewer.md#links-and-unsent-work) for unsent-work protection.

**Web pages.** Links browse within the viewer; links that request a new window open in your browser instead.

You don't have to scroll back for a link the agent printed: `Ctrl/Cmd+Shift+U` lists your recent viewers, and typing finds files that never appeared in the terminal ([open a viewer](viewer.md)).
