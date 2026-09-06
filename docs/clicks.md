# What a click does

Plain-click a marked target to follow it. Existing viewer and web links open immediately; IDE and OS targets wait briefly so a selection gesture can take priority. `Ctrl/Cmd`-click skips that wait.

Commenting comes first. On a target with delayed navigation, a second press cancels the pending jump immediately: double-click selects a word, triple-click selects a line, and typing comments on that selection. Dragging or holding the first press also cancels the jump. Escape, typing, scrolling, another click, or leaving the window cancels a pending jump. The wait follows the system's double-click timing; selection and freezing respond as usual. Drag-selection works across immediate links too; their existing double-click behavior is unchanged.

**Plain click, in the window.** Whatever the agent prints that renders opens in a viewer band above the prompt: a markdown path (`docs/plan.md`) in the md viewer, a `review://` link in the review viewer, an image, a video, an audio file or a PDF in the band, a local page (`file://`, `.html`) in the web band. A diff line on a doc, the common case when the agent edits one, jumps to that line in the md viewer, for you to comment on or edit.

**Plain click after a pause, to another application.** A symbol, a `file:line`, or a diff or source line over code goes to your IDE at that line ([ide](ide.md)). A bare path, a folder, an archive, an office document, or a media format the band cannot play (`.mov`, `.avi`) goes to the OS handler. These targets keep their quiet appearance until hovered; their underline responds to a plain click. `Ctrl/Cmd`-click follows them immediately.

**Web links.** A plain click on an `http(s)` URL opens your browser, where logins, SSO cookies, and device auth already live. `Ctrl/Cmd`-click pulls the page into the in-app web band instead.

Inside the md viewer, a plain click on a link arms the block under it for a comment; `Ctrl/Cmd`-click follows the link.

You don't have to scroll back for a link the agent printed: `Ctrl/Cmd+Shift+U` lists your recent viewers, and typing finds files that never appeared in the terminal ([open a viewer](viewer.md)).

**The one thing to remember:** click to follow, select to comment; `Ctrl/Cmd`-click skips the pause on IDE and OS targets.
