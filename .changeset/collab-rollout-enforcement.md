---
"cognia-next": patch
---

Collaboration server: a paused, killed or not-yet-offered shared feature now refuses new shared chats, invites, runs and Canvas edits with a `feature_unavailable` reason while reads, exports, leaving and cancelling keep working; sessions and Canvas documents remember the protocol version they were created with, so an older client can read them but not change them.
