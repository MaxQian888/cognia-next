---
"cognia-next": minor
---

CLI: the transcript render preferences now apply in the fullscreen layout, which is the layout most people run.

`toolResultMaxLines`, `pagerThresholdLines`, `fileLineNumbers` and `syntaxHighlightInline` reached only the scrollback renderer, so in fullscreen a settled tool result printed in full, unnumbered and uncoloured however the settings panel was set. A large result rendered while a turn was live and then re-rendered without its cap the moment it was committed.

- The fullscreen renderer reads the same preferences and applies the same line cap, pager fallback and number gutter as the cards.
- Syntax highlighting reaches it too: tool result bodies, fenced code in a reply, and diff bodies are coloured token by token instead of painted one flat colour. A new ANSI-to-span bridge converts the highlighter's escape sequences into styled runs, so colour arrives without breaking the renderer's cell-exact width accounting.
- `/transcript` renders verbatim: no cap, no gutter, no colour, because it is read and copied as source.
