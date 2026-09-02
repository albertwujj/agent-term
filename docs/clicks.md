# What a click does

One rule: a plain click keeps you in the window, and `Ctrl/Cmd`-click hands you to another application. Web links are the one exception, below.

The rule is shaped for commenting. Selecting output to comment on it is the most frequent gesture here, and a double-click on a word is a selection too; so only the most common targets (what stays in the window) earn the plain click, without the modifier. A word that looks like a symbol or a path stays a word by default.

**Plain click, in the window.** Whatever the agent prints that renders opens in a viewer band above the prompt: a markdown path (`docs/plan.md`) in the md viewer, a `review://` link in the review viewer, an image in the image viewer, a local page (`file://`, `.html`) in the web band. A diff line on a doc, the common case when the agent edits one, jumps to that line in the md viewer, for you to comment on or edit. The viewer is part of the terminal, and expands and hides on its own.

**`Ctrl/Cmd`-click, to another application.** A symbol, a `file:line`, or a diff or source line over code goes to your IDE at that line ([ide](ide.md)). A bare path, a folder, a pdf, an archive, or an audio or video file goes to the OS handler.

**Web links.** A plain click on an `http(s)` URL opens your browser, where logins, SSO cookies, and device auth already live. `Ctrl/Cmd`-click pulls the page into the in-app web band instead.

Inside the md viewer, a plain click on a link arms the block under it for a comment; `Ctrl/Cmd`-click follows the link.

`Ctrl/Cmd+Shift+U` lists everything the session can open in a viewer; `Ctrl/Cmd+Shift+O` and `+I` grow and shrink the open band. Commenting works the same in every viewer ([comment](comment.md)).

**The one thing to remember:** if a plain click does not do what you want, `Ctrl/Cmd`-click it.
