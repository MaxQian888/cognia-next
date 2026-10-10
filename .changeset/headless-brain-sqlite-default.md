---
"cognia-next": minor
---

The headless brain (`cognia-agent serve`) now stores data in SQLite by default instead of a debounced JSON snapshot, so an always-on host no longer loses its last few seconds of writes on a crash. An existing account is imported once on first boot and its old snapshot store is left untouched; `COGNIA_DURABILITY_BACKEND=snapshot-v3` keeps the old store. Setting `COGNIA_DURABILITY_BACKEND` on a new account now takes effect (it was silently ignored), and a new account pinned to SQLite no longer fails on its first write.
