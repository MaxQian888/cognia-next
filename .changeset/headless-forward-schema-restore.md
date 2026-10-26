---
"cognia-next": patch
---

Headless and shared Hosts keep their data across an app update that adds database tables: the brain (and every member's personal space) now restores a checkpoint written by an older build instead of refusing to start, and plugin data is no longer dropped once the app's own schema version catches up with it.
