---
"cognia-next": patch
---

The conversation sidebar no longer lists a chat twice (or logs a duplicate React key warning) when a live-query refresh hands it the same conversation more than once — for example around a drag reorder or a new-chat insert. The list model and `useSessions` now collapse repeated rows to one, keeping the freshest copy, and a repeated workspace/agent group id no longer emits a duplicate section.
