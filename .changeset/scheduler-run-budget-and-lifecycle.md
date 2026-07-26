---
"cognia-next": minor
---

Harden scheduled-task execution semantics. Due slots are claimed atomically and reserve `maxRuns` before overlapping work can start, cadence advances from the persisted slot, overlap queues and retry chains retain their trigger context, and stop, pause, delete, startup, and Rust-daemon arm/disarm races no longer leave stale executions, retries, or alarms behind.
