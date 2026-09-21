---
"cognia-next": patch
---

Fix the slash-command popover's sticky section header reading as a blank strip: it now renders as an opaque bar with a bottom rule (no translucent bleed-through of half-covered rows), and rows gain a scroll-margin so keyboard navigation lands them below the stuck header instead of hiding the command name line underneath it.
