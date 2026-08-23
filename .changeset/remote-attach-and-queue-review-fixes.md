---
"cognia-next": patch
---

Fix remote session control never granting an attachment, and stop the outbound queue losing or stranding work

- `session_attach` never conferred control: the Host serialized each event-plane lease as `id` while the renderer read `leaseId`, so every stream was discarded and remote approval prompts were auto-denied. A device without Remote Control now also falls back to a read-only observe attachment instead of being refused outright and re-refused every 30s.
- A suspended or revoked device now loses its attachments immediately rather than keeping them for the full lease TTL, and lapsed leases are pruned instead of accumulating.
- Session state no longer grows without bound: settled operations and decisions are trimmed, so a long-running session's snapshot can never cross the size ceiling and lock the client out of syncing.
- An interrupted turn is reported as aborted instead of completed, and a message the runtime drops now leaves the queue instead of showing as pending forever.
- Upgrading no longer deletes queued-but-unsent messages, drafts and decision answers; they are migrated to the new shape.
- The needs-input notification's deep link now opens the session it is about.
- The offline banner counts rows actually being dispatched instead of a status the queue could never reach.
