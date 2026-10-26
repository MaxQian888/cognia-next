---
"cognia-next": patch
---

A shared-chat run no longer stops on a single network blip during its lease heartbeat; it stops immediately when the server refuses the lease, and otherwise only once the lease could no longer be renewed.
