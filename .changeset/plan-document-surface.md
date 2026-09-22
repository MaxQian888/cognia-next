---
"cognia-next": minor
---

Document-first plan surface: plans captured from `exit_plan_mode` now render their full markdown body with the executable step list embedded in place — edit a step and the document itself is rewritten (debounced autosave, no save button). Long plans get a sticky single-row TOC strip with anchor jumps and scroll-spy. A new Plan panel in the right-side dock lists the session's plans newest-first (the GUI counterpart of `/plan list`), edits the awaiting-approval draft through the same shared `applyPlanEditPatch` path as the approval card, and renders terminal plans read-only with their lifecycle event trail.
