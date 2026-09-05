# Comment on the agent's output

![select a claim in the agent's brainstorm and ask, right on the output](assets/comment-brainstorm.png)

Most of what an agent tells you scrolls past in the terminal (`Ctrl/Cmd+F` fuzzy-searches the whole scrollback). Double-click a word, triple-click a line, or select as usual, and comment; your note goes back to the agent with the exact text quoted, so a few words are enough.

![the sent message carries the quoted selection, and the agent acts on it](assets/comment-sent-brainstorm.png)

It works the same on the rendered markdown viewer.

A click opens whatever the agent prints that renders (docs, reviews, images, video, PDFs) in a viewer inside the window; a web link opens in your browser. The full rule, with the IDE and OS handoffs: [what a click does](clicks.md). You can also open a viewer without a click ([open a viewer](viewer.md)).

A shell this terminal opens asks Claude Code for its classic renderer, so the conversation stays in the scrollback that selecting, `Ctrl/Cmd+F` and the marks on the scrollbar all read. Prefer its fullscreen rendering — `/tui fullscreen`, or `CLAUDE_CODE_NO_FLICKER=1` in your environment, which this terminal leaves alone — and clicks still open what the agent prints, but selecting needs `Shift` held down.
