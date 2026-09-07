# Clickable patterns

Terminal output is made clickable by matching text against a list of patterns: `patterns` in `src/renderer.js`, each with a regex, an optional filter, and an action, resolved per row by `parseRow`. The list itself is the reference; what follows is what reading it does not tell you.

## Why the set looks like this

Two sources feed it. Tools print shapes that predate agents and are worth matching because everything emits them: Python tracebacks, GitHub `#L` anchors, compiler `file:line:column`, MSBuild's `file(42,15)`. Agents print shapes of their own: diff hunks, quoted source blocks, prose line references ("Lines 597-625"), and the `review://` links this terminal opens itself.

Symbols are different in kind. Nothing here knows the language, so `qualified_symbol`, `underscore_symbol` and `camel_pascal_symbol` match by shape alone and hand the name to the IDE plugin to resolve. That trade buys coverage in any language and pays for it in noise, which is what each pattern's `filter` holds down; the reasons sit with them.

## Two tiers, not one list

`parseRow` places matches in two passes. High-priority patterns (files, URLs, explicit line references) are placed first, greedily, earliest start winning and the longer match winning a tie. Low-priority ones (`priority: 'low'`: symbols, source lines, diff blocks) then fill only the spans nobody claimed. So a symbol inside a path never wins by being longer; it never gets the chance.

Order within the list is the remaining tiebreak, which is why the file patterns run most specific first.

## The file hint

A symbol alone is ambiguous, so its click carries the nearest file mentioned above it: `findFileContext` scans back up to 200 rows, and on the clicked row itself takes the rightmost path ending before the click. That is the whole of this side.

The other side lives in the [IntelliJ Navigator plugin](https://github.com/albertwujj/intellij-navigator/blob/main/API.md): the hint is matched by path suffix, and a hint that matches nothing is dropped rather than narrowing the result to nothing. A wrong hint therefore costs precision, never the jump.

## Adding one

Put it in the list in priority order, give it `priority: 'low'` if it should yield to files and URLs, and add cases to `test/patterns.test.js`. A `filter` runs before decoration, so what it rejects is never underlined.
