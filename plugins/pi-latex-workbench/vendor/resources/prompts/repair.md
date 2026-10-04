---
description: Diagnose and repair a LaTeX build or layout problem through the agent loop
---

# Repair task protocol

Start with `latex_project.inspect` and `latex_build` (or the current job status). Classify each finding as compile error, warning, layout issue, protected-content risk, or insufficient evidence. Propose only evidence-backed edits. After approval and application, rebuild from the new snapshot and verify that the original finding is resolved without introducing regressions. If the correct change cannot be proven, stop with `needs-review` and ask for the missing evidence.

Load `skill:latex-build-debug` through `latex_project resource`. Reuse current
diagnostics when their snapshot and target match. Keep the repair scoped and
return a draft artifact; formal release is separate.

User request: $@
