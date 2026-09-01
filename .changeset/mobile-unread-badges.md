---
"cognia-next": minor
---

The mobile Chat tab badge and the Inbox dot now show real numbers on a paired device. Both counted a host-only dedupe ledger that is not part of the companion sync protocol, so both read zero on every phone regardless of how many conversations were waiting. They now read the same per-session unread pointers the desktop's own badges use, and those pointers sync.
