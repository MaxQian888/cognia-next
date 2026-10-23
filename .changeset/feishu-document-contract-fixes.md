---
"cognia-next": patch
---

Fix Feishu document search token resolution, CLI ingestion, edit arguments, and image block placement.

Prevent stale Google OAuth callbacks and refreshes from restoring disconnected connections, keep connection settings reactive, classify Drive quota failures correctly, and honor caller cancellation. Reject truncated Feishu CLI output before source creation.

Move Google document connection state into an atomic host-owned record so independent renderers share disconnect fences, single-use OAuth claims and bounded revocation barriers. Prevent account substitution in delayed or shared refreshes, and propagate only connection reload signals across the native and internal service transports.
