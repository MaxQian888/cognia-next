---
"cognia-next": patch
---

Fixes messages being silently skipped when something other than the chat pipeline writes to a session. `persistMessages` keeps an in-memory snapshot of the last committed write so streaming only rewrites changed rows, and that snapshot is only correct while nothing else touches the session's messages — its own comment says any out-of-band write "must call `invalidatePersistSnapshot`". Eight writers did not: inbound platform messages, Lark imports, both inbox relay paths, an IM edit, an IM delete, and the plugin bridge's create/update/delete. An IM message arriving mid-stream, or a plugin editing a message, left the snapshot reporting those rows as unchanged, so the next persist skipped them. All eight now invalidate.
