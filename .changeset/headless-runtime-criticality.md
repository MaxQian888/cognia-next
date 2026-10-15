---
"cognia-next": minor
---

Distinguish required headless runtimes from optional functionality. Required startup failures and restarts keep the host unready, while optional failures remain degraded. Report bootstrap completion immediately, show runtime criticality and backup/storage warnings on the device page, and preserve compatibility with older hosts.

Native and Compose self-update trials compare required failures with the pre-update baseline, so only new failures can prevent trial completion and cause rollback. Readiness probes and tier-2 smoke now check required runtime readiness; restart-triggering probes use process liveness.
