---
"cognia-next": patch
---

Recover from a boot hang where the loading spinner never clears. When a secondary window (desktop pet overlay, fleet island, or a second tab) holds an older IndexedDB schema version open, the main window's schema upgrade blocks; on WebKit the one-shot cross-window yield nudge could be missed, leaving `db.open()` pending forever. The blocked open now re-sends the yield request on an interval (so a late-registering overlay still releases the old version) and gives up loudly after a cap instead of spinning silently.
