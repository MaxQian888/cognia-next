---
"cognia-next": patch
---

Stop CLI schema bumps from tombstoning local snapshots: only snapshots written by a
newer build are quarantined, older ones restore as a forward move, and a missing
manifest self-heals from the newest coherent quarantine generation. Concurrent CLI
processes now serialize through a `${file}.lock` single-writer lock; losers run
read-only and never mutate the store, and manifests carry writer diagnostics.
