---
"cognia-next": patch
---

The embedded browser now reports how each URL change happened — a new document, an SPA push, a replace, or a back/forward traversal — so the preview can model its own history accurately. On its own this changes nothing you can see; it is what the back/forward buttons need in order to know when they have somewhere to go.
