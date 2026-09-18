---
"cognia-next": patch
---

Fix inconsistent button styles in the AI Connections rail toolbar: the sort trigger rendered 36x36 while the add / export / import buttons rendered 32px tall at mixed widths with uneven gaps, so the row visibly mismatched the h-9 search box. All four actions now share the same 36x36 outline icon geometry with uniform spacing, and the add button's wide-rail label reveal still works.
