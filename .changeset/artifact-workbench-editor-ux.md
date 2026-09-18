---
"cognia-next": patch
---

Workbench/editor UX fixes: switching files no longer unmounts the editor or flashes the empty state — the previous file stays mounted under a delayed loading veil until the read lands, and a failed open restores the previous selection instead of parking on a phantom tab. Horizontal tab strips (workbench panels, groups, activity rail, artifact strip, editor tabs) still scroll but no longer paint a scrollbar. The workbench header names the active panel instead of leaving dead space. The session summary dock widens from 280px to 320px and its card now stays mounted through the shared close animation instead of vanishing in one frame.
