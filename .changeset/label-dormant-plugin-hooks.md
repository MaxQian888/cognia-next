---
"cognia-next": patch
---

Ten plugin hook points that the host never fires — the scheduler CRUD hooks and the workflow node/trigger registration hooks — are no longer advertised to plugin authors as stable and implemented. They report `virtual` status, and registering a handler for one now surfaces a `plugin.point.virtual` warning instead of silently never running. A new `pnpm audit:hooks` gate keeps the label honest in both directions.
