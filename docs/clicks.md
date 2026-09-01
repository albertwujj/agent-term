# What a click does

One rule: a plain click keeps you in the window, and `Ctrl/Cmd`-click hands you to another application. Web links are the one exception, below.

**Plain click, in the window.** Whatever the agent prints that renders opens in a viewer band above the prompt: a markdown path (`docs/plan.md`, or `README.md:42`) in the md viewer, a `review://` link in the review viewer, an image in the image viewer, a local page (`file://`, `.html`) in the web band. A diff or source line whose file is a doc jumps to that line in the doc viewer. The scrollback stays where it is, and `Esc` puts the band away.

**`Ctrl/Cmd`-click, to another application.** A symbol, a `file:line`, or a diff or source line over code goes to your IDE at that line ([ide](ide.md)). A bare path, a folder, a pdf, an archive, or a media file goes to the OS handler, and so does a local page or image the band would otherwise render. The modifier is the price of an application switch, so a stray click changes nothing, and the first press of a double-click meant to select a word for a comment stays a selection.

**Web links.** A plain click on an `http(s)` URL opens your browser, where logins, SSO cookies, and device auth already live. `Ctrl/Cmd`-click pulls the page into the in-app web band instead.

Inside the md viewer, a plain click on a link arms the block under it for a comment; `Ctrl/Cmd`-click follows the link.

`Ctrl/Cmd+Shift+U` lists everything the session can open in a viewer; `Ctrl/Cmd+Shift+O` and `+I` grow and shrink the open band. Commenting works the same in every viewer ([comment](comment.md)).
