---
"cognia-next": minor
---

TUI: opt-in drag-to-select with auto-copy, plus a wider set of copy/click shortcuts.

`/select` turns on in-app text selection over the rendered frame — `manual` paints a
highlight the copy chord picks up, `auto-copy` puts the selection on the clipboard the
moment you let go (划词自动复制). Double-click selects a word, triple-click a row, and Esc
clears the highlight. It works over SSH, since the copy goes through the existing OSC 52
path rather than the terminal's own selection. Off by default; requires the fullscreen
layout with the `scroll` mouse model.

New shortcuts, all rebindable in `/settings`: Ctrl+S copies the selection; Ctrl+X Ctrl+U /
Ctrl+B / Ctrl+O / Ctrl+A copy your last message, the last code block, the last tool output,
and the whole conversation as markdown; Ctrl+X Ctrl+P swaps the mouse model and Ctrl+X
Ctrl+S cycles the selection mode. Ctrl+click on the transcript opens the file path under
the pointer in `$EDITOR`, copies the URL under it, or copies the clicked row. `/copy user`
is a new target for the last message you sent.
