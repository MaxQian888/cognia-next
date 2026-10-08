---
"cognia-next": patch
---

Reduce workspace conversation query decryption using existing index keys, and aggregate pending read watermarks once per sync slice while preserving unread choices, account isolation and cursor semantics.

Reuse canonical execution-event history within each batch transaction attempt to avoid repeated IndexedDB reads while preserving replay, rollback, deduplication, and notification updates.

Use the existing read-state/time index for single-state notification queries while preserving filters, timestamp ordering, and live updates.

Avoid loading previous encrypted session rows during sync unless their managed workspace bindings require a local-context merge; retain slice boundaries, cancellation fences, and portable-path handling.

Use the existing workflow/status index when listing one workflow's unacknowledged failures, avoiding reads of other workflows' encrypted run snapshots while preserving global queries and ordering.

Compute storage health from the overview's freshly loaded statistics so each load and refresh performs one database walk. Independent health requests still read fresh statistics.
