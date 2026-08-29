---
"cognia-next": patch
---

Workflow editor: the Settings and Runs panels now size against the panel instead of the window. Both live in the Context Workbench column, which drags down to 240px and is re-hosted full-bleed in a sheet on mobile — but their paired fields and stat strips were keyed off viewport breakpoints (or nothing at all), so on any wide desktop they kept two or four columns inside about 200px of space. The run summary stats, the run list's stat strip and the settings panel's paired inputs now collapse to one column when the panel is narrow, and pinned tests keep them that way.
