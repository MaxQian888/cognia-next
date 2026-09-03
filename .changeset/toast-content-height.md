---
"cognia-next": patch
---

Toasts are sized by their content again. Sonner renders every toast at a height it measured once at mount and never re-measures, so a toast whose layout changed underneath it (the app crossing Sonner's own 600px breakpoint, or the appearance appliers rewriting typography/density/radius after first paint) stayed pinned at the old height: a two-line error painted as a several-hundred-pixel-tall box with its text stranded near the top. Toast height now follows the content, is bounded, scrolls inside that bound, aligns the icon with the first line, and wraps long unbreakable tokens (ids, URLs, paths) instead of pushing the close and action buttons out of the box.
