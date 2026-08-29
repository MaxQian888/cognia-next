---
"cognia-next": patch
---

Workflow editor: locking a node now actually locks it, and says so. The selection toolbar's lock button wrote the flag and flipped its icon, but only the workflow _loader_ translated that flag into React Flow's `draggable` — so a node you locked kept moving, and a node that loaded locked stayed pinned after you unlocked it, until the workflow was reopened either way. The toggle now takes effect immediately in both directions, and a locked node carries a small lock mark so its refusal to move has a visible reason instead of reading as a stuck canvas.
