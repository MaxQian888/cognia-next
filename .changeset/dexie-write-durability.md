---
"cognia-next": patch
---

Fixes writes that could be silently lost when the local database was reopened underneath them — most visibly when switching runtime targets. Goal, loop, plan and connector job writes now retry and verify durability before reporting success, audit and telemetry pruning no longer holds a long-lived transaction, and two events recorded in the same millisecond keep their order.
