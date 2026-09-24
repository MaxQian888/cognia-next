---
"cognia-next": patch
---

Fix message multi-select UX and the hover action bar vanishing under its own overflow menu. The row checkbox no longer appears on hover — selection mode is entered deliberately via the message's "More" menu ("Select messages") or the long-press sheet on touch, removing accidental activations and hover noise; ticks still render on every selectable row once the mode is on. The message action bar now also stays visible for the whole lifetime of an open Radix popup inside it (the "⋯" menu and plugin menus portaled out, where neither hover nor focus-within held).
