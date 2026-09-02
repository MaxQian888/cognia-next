---
"cognia-next": patch
---

The composer's caret sits where the text does again. The textarea's glyphs are transparent and three mirror layers paint them, and those layers were pinned to the iOS zoom guard's 16px while the textarea itself now renders at 14px on a desktop, so the caret drifted left of the painted text by about a third of a character per character typed. It is most visible in `!` shell mode, where the mono face makes every glyph the same width. Both sides now read one variable declared beside the guard, so they cannot disagree in either pointer regime.
