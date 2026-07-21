# Markdown Viewer Test

This file is a compact fixture for testing AgentTerm's rendered markdown viewer. Click this paragraph, type a comment, and confirm that the inline editor appears beneath the rendered paragraph instead of showing raw markdown source.

The viewer should land near this paragraph when opening a path with a line reference. This paragraph is intentionally long enough to wrap in the rendered pane, which helps verify that the highlight applies to the rendered block rather than a physical terminal row.

## Basic Formatting

Rendered markdown should show **bold text**, *italic text*, `inline code`, and a normal link to [OpenAI](https://openai.com). Comments should attach to the rendered paragraph as a whole for now.

- First list item for block-level anchoring.
- Second list item with **emphasis** and `inline code`.
- Third list item that is a little longer, so it wraps naturally and gives us something larger to click.

> This blockquote should have a visible left rule and should also be commentable as a rendered block.

## Code Block

```js
function greet(name) {
  const safeName = name || 'reader';
  return `hello, ${safeName}`;
}
```

The fenced code block above should render as code, not source markdown. For this first slice, comments attach to the whole code block. Auto-refresh test update: this sentence was added while the viewer stayed open. Second refresh test update: the bottom strip should now animate for longer. Third refresh test update: this should trigger the three-cycle refresh animation.

## Diff Line Target

```diff
@@ -1,4 +1,4 @@
-The markdown viewer rendered raw source here.
+The markdown viewer renders this fixture and lands on diff-selected text.
 Context line for testing markdown viewer landing from terminal diff output.
```

Clicking a matching added or context diff line from terminal output should open this rendered fixture and land near this section.

## Table

| Area | Expected behavior |
| --- | --- |
| File click | Opens rendered markdown viewer |
| Line click | Scrolls to the nearest rendered block |
| Comment | Inserts an inline card beneath the block |
| Enter | Sends the markdown comment to the AI CLI |
| Shift+Enter | Inserts a newline in the comment |

## Tall Table

This table is intentionally tall so the spread layout can split it across the left and right sides as consecutive pixel ranges.

| Row | Scenario | Expected result |
| --- | --- | --- |
| 1 | Table starts in the left side | Header remains readable |
| 2 | Table continues downward | No row is skipped |
| 3 | Viewer boundary intersects the table | Right side starts at the next pixel range |
| 4 | User reads down the left side | Reading continues at the top of the right side |
| 5 | Table cells contain prose | Wrapping remains consistent |
| 6 | Table cells contain prose | Wrapping remains consistent |
| 7 | Table cells contain prose | Wrapping remains consistent |
| 8 | Table cells contain prose | Wrapping remains consistent |
| 9 | Table cells contain prose | Wrapping remains consistent |
| 10 | Table cells contain prose | Wrapping remains consistent |
| 11 | Table cells contain prose | Wrapping remains consistent |
| 12 | Table cells contain prose | Wrapping remains consistent |
| 13 | Table cells contain prose | Wrapping remains consistent |
| 14 | Table cells contain prose | Wrapping remains consistent |
| 15 | Table cells contain prose | Wrapping remains consistent |
| 16 | Table cells contain prose | Wrapping remains consistent |
| 17 | Table cells contain prose | Wrapping remains consistent |
| 18 | Table reaches lower content | No duplicate table block should appear |

## Scrolling

This section creates enough content to test the viewer's scroll behavior. Comment cards should move with the rendered markdown content because they are inserted inline in document flow.

Paragraph one for scroll testing. The content is plain text, but it should still preserve clean document spacing and readable line height in the viewer.

Paragraph two for scroll testing. Click this paragraph after scrolling and verify that the active highlight is a subtle gray on the white background.

Paragraph three for scroll testing. If the markdown pane is smaller than the document, the scrollbar should stay inside the viewer rather than scrolling the terminal.

Paragraph four for scroll testing. The terminal behind the viewer should remain visible above and below the middle band.

Paragraph five for scroll testing. Closing and reopening the viewer should replace the rendered content cleanly without leaving stale highlights.

## Final Target

This final paragraph is useful for testing line landing near the bottom of the document. A click on a diff or line reference targeting this area should scroll the viewer down and highlight this rendered paragraph.
