---
"cognia-next": patch
---

Fix a scheduler startup storm: when the app had been closed for longer than a recurring task's period, the timing driver replayed every missed slot back-to-back — flooding the log with `execution skipped due to overlap-skipped` warnings, writing one skipped execution record per missed slot, and re-firing recurring work (most visibly the IM usage-status refresh, which pushed repeated presence updates). An overdue window now goes through the missed-run policy once (`runMissedOnStartup` / `maxMissedRuns` / `catchupWindowMs`) and re-arms on the next future slot.
