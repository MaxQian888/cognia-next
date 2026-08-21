---
"cognia-next": patch
---

The chat transcript no longer jitters. While a reply streams, the scroll correction now lands in the same frame that paints the growth instead of a frame later, so the prose stops ticking up and back under the caret; the row being streamed into renders at its real height rather than a character-count projection. While a long tool-heavy turn runs, the thinking indicator stops moving the reading column — its rotating verb no longer shunts the dots sideways, its rotating tip sits in a fixed two-line box, and neither forces a scroll any more. Expanding a tool card, a reasoning block or a sub-agent body is now a single reflow instead of one per frame, and the streaming caret is inline rather than a permanent extra row that vanished when the turn ended.
