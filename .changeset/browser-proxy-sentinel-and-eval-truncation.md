---
"cognia-next": patch
---

Fix two embedded-browser defects: with a manual network proxy configured, the previewed page was destroyed and recreated pointing at the internal `cognia.invalid` sentinel host (the address bar visibly changed) as soon as the page reported a load, a selection, or console/network activity; and evaluating a large expression against a non-Latin page (for example reading `outerHTML` on a Chinese site) could crash the eval bridge on a UTF-8 boundary.
