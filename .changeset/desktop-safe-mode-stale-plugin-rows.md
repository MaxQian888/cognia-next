---
"cognia-next": patch
---

Desktop no longer gets stuck in diagnostics safe mode after an update: built-in plugins are checked against the manifest the build ships instead of a stale stored copy, and a restart re-runs read-only checks that failed in an earlier session.
