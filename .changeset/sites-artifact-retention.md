---
"cognia-next": minor
---

Sites: build archives are now garbage-collected. Every version a deployment serves, the rollback target, anything behind an unfinished operation, and the recent rollback window are preserved; everything else is released by the daily sweeper or by a new Reclaim space action, and the resources tab shows what the archives occupy on this machine.
