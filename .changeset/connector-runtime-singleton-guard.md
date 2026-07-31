---
"cognia-next": patch
---

Guard against a second window double-running the connector runtime. The connector subsystem (bot transports, outbound send queue, socket reap) assumes exactly one owning window; if a second one ever booted it, they would double-send replies, double-fire scheduled digests, and reap each other's live sockets. Boot now acquires a cross-window exclusive lock first and a second instance declines to start (logging why) instead of colliding with the owner.
