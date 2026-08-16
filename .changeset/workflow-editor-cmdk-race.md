---
"cognia-next": patch
---

fix(workflow): ⌘K in the workflow editor no longer opens two palettes at once — the editor's command palette moved off its raw window listener onto the shared shortcut dispatcher, so it and the global search are mutually exclusive and both are rebindable
