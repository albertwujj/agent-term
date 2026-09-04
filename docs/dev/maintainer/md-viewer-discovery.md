# Markdown Viewer Discovery Summary

Relevant pieces:

- Clickable terminal references live mostly in `src/renderer.js`.
- Existing deleted diff-line fallback already scans forward via `findMinusTarget` in `src/renderer.js`.
- Click hit-testing is buffer-position based in `src/renderer.js`.
- AI submission should reuse the main-process `writeAsSubmission` timing logic in `src/main.js`, not raw renderer writes.
- File opening exists, but markdown viewing needs a new "resolve/read markdown file" IPC; current resource opening is only OS-open behavior in `src/main.js`.
- No markdown rendering dependency exists today.

The worktree was already dirty in several files during discovery; no changes were made during the discovery pass.

## Markdown Stack

Recommended stack for the MVP: `markdown-it`.

Why it fits this repo:

- It works cleanly with CommonJS/esbuild, matching the current renderer style.
- It is fast and lightweight.
- It exposes token source maps: `Token#map` is `[line_begin, line_end]`, which is exactly what we need for rendered-block-to-source-line anchoring.
- It is safe by default with raw HTML disabled.
- We can collect heading hierarchy from heading tokens without a heavier AST stack.

Suggested setup:

```js
markdown-it({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
})
```

Then add custom renderer rules that attach source line metadata to block elements:

```html
data-source-start-line="12"
data-source-end-line="15"
```

Use that on headings, paragraphs, lists, blockquotes, code fences, and tables.

I would not use `marked` here. It is fast, but its own docs warn that it does not sanitize output, and line anchoring is weaker. I would also avoid `remark`/`rehype` for the MVP: it is more semantically powerful and has real AST positions, but it is heavier and modern packages are ESM-first. It is the better fallback if we later decide exact inline source positions inside paragraphs matter.

## Important UX Caveat

Rendered markdown does not always preserve source "lines." A paragraph with three source lines usually renders as one visual paragraph. For the MVP, anchor comments to the rendered block containing the source line. So a line inside a paragraph highlights that paragraph and inserts the comment beneath it. Headings, list items, code fences, and tables will feel more exact.

## Implementation Slice

Proposed next implementation plan:

1. Add `markdown-it`.
2. Add `readMarkdownFile` IPC: resolve `.md` path, read content, return resolved path/content.
3. Add `md-viewer.js`: middle-band viewer, rendered markdown, source-line block index, landing highlight.
4. Route `.md` path/file-line clicks to the viewer instead of IDE navigation.
5. For deleted diff lines targeting markdown, reuse the existing next non-deleted line rule, but only for landing highlight.
6. Add generic `commentQueue` / `annotationTarget` model so the later double-click-anywhere feature can reuse it.
7. Add `submit-ai-comment` IPC that calls `writeAsSubmission`.
8. Tests for markdown routing, deleted-line fallback, line-to-rendered-block mapping, section hierarchy, and comment queue behavior.

Sources checked:

- https://markdown-it.github.io/markdown-it/
- https://github.com/markdown-it/markdown-it
- https://github.com/syntax-tree/unist#position
- https://marked.js.org/
- https://github.com/rehypejs/rehype-sanitize
