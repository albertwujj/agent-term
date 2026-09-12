# Copy a doc into a message

A plan or a draft written in the viewer often ends up as a message: a Teams post, an email, a reply on GitHub. The copy button at the right of the viewer's bottom bar copies it in the form the destination needs, so nothing is retyped or cleaned up on the other side. Your comments and unsent edits stay behind, whichever copy you take.

**Plain text, for Teams or email.** A click copies text only: headings drop out, each paragraph becomes one line, list items stay one per line, code keeps its line breaks, and a blank line separates the blocks.

**Copy takes what you have clicked.** With nothing clicked, the whole doc. With a heading clicked, the section under it, up to the next heading of the same level. With a paragraph, a list, or a code block clicked, that block. The button's label says which before you click.

<p align="center">
<img src="assets/copy-states.png" width="136" alt="the copy button's four states: ⧉ text with nothing clicked, ⧉ section with a heading clicked, ⧉ paragraph with a paragraph clicked, and ✓ md after a markdown copy">
</p>

**Markdown, for GitHub or Reddit.** `Ctrl/Cmd`-click the button to copy the markdown source of the same scope, for a surface that renders markdown itself.

**From the terminal.** `Ctrl/Cmd+C` on a selection copies it as message text, the terminal's padding removed, so text pasted into an email or a chat needs little or no fixing. `Ctrl/Cmd+Shift+C` copies the selection as a plain terminal would. On Windows, `Enter` with a selection copies the same way.
