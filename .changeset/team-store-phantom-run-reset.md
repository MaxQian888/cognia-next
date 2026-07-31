---
"cognia-next": patch
---

Stop showing a phantom "running" agent team after a reload. A team interrupted mid-run (planning / executing / paused) only had its status reset during a cross-version storage migration, so a plain same-version reload rehydrated it as if it were still live — with no controller behind it. The stale-status reset now also runs on every rehydrate and on account switches, so an interrupted team correctly shows as idle after restart.
