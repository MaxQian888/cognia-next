---
"cognia-next": patch
---

Threads report back to their coordinator (ADR-0204 groundwork): lifecycle-linked sessions pass peer messages through background holds and queue them when the receiver is not live, thread results travel as coalesced coordinator-bound reports, and a single store observer settles every thread turn and releases its hold.
