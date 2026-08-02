---
"cognia-next": minor
---

Headless brain durability ladder: add the `journal-v4` (checkpoint + checksummed transaction journal) and `sqlite-v5` (Node built-in SQLite, WAL) backends behind a `HeadlessDurabilityBackend` port, plus `cognia-agent durability verify|migrate|recover|rollback|finalize` for inspection, parity-gated backend switches, and lossless recovery. Committed Dexie transactions are now `fsync`ed before they resolve, closing the crash window the debounced snapshot left open.
