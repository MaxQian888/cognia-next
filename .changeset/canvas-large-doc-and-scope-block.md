---
"cognia-next": minor
---

Canvas now degrades deliberately on large documents instead of quietly getting slow: past 1,500 lines the minimap, folding and occurrence highlighting switch off (sticky scroll and word wrap follow past 5,000), and a notice says so rather than leaving it to look like breakage.

Canvas AI suggestions also get a bounded scope summary — which function or class the caret sits in, what the file exports and depends on. The suggestion prompt only ever sent a window around the caret, so that was exactly the context it lacked.
