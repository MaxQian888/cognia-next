---
"cognia-next": patch
---

Canvas documents are now scoped to the active workspace everywhere they are listed or looked up: the document rail, the empty state, document cycling, the plugin API, the `canvas_read`/`canvas_update` tools, the `action.canvas.get` workflow node and the reveal seam. Switching workspace no longer leaves the previous workspace's documents on screen, and a model or plugin running in one workspace can no longer read or rewrite a document owned by another.
