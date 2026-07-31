---
"cognia-next": patch
---

Public share links can now be extended instead of recreated: the "My shared links" panel (Settings → Data) gains an "Extend expiry" action that pushes a link's expiry to a week out, backed by a new owner-token-gated renew endpoint on the share worker (the grant is clamped to the worker's hard TTL ceiling and mirrored locally).
