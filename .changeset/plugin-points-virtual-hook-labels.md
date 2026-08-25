---
"cognia-next": patch
---

Correct the published plugin-point contract: the six scheduler CRUD hooks and the four workflow node/trigger registry hooks are now reported as `experimental`/`virtual` instead of `stable`/`implemented`, matching the fact that no host fires them.
