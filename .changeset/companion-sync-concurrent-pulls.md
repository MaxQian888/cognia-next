---
"cognia-next": patch
---

Companion sync now pulls tables concurrently instead of one at a time. A paired phone or web client used to spend one full round-trip per table on every cold start and every reconnect, all 47 of them in sequence, even when nothing had changed. Up to six now run at once, with the orderings that were previously implied by array position (characters before sessions, labels before issues, a squad before its roster) declared as explicit dependencies and pinned by tests. The bootstrap drops from 47 sequential round-trips to about ten, and the `critical` stage that gates "online" drops from five to two.
