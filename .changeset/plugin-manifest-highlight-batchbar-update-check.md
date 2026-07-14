---
"cognia-next": patch
---

Improve the plugin detail viewer and fix two plugin-panel defects. The "raw manifest" viewer now renders the manifest as syntax-highlighted JSON (with copy / download / line numbers) instead of a flat monochrome block, both for installed plugins and — newly — in the marketplace detail sheet before installing. The floating batch-actions bar no longer collapses into a broken vertical stack — it stays a horizontal toolbar that only wraps when genuinely too narrow. And "Check for updates" no longer repeatedly re-hits an unreachable registry and floods the console: failed marketplace lookups are briefly negative-cached and logged quietly, and the update dialog / batch "Update" action now actually install (they previously threw on a missing method and displayed "v undefined → v undefined").
