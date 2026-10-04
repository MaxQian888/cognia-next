---
description: Review LaTeX source, compilation or layout without editing
---
Perform a read-only review of the requested scope. Start from machine
evidence: build the current head (or reuse its build) and run
`latex_check` with `rulesetId: "draft"` on the PDF — it lints references,
duplicate labels, citations vs the bibliography, floats, placeholders,
typography and the build log, with file:line findings. Then read the relevant
source and, for layout questions, render the affected pages. Use workbench
skills through `latex_project resource` where they apply. Report findings and
proposed fixes; do not apply patches or start a release. Distinguish lint
findings, build diagnostics, your own reading of the source, and actually
observed PDF pages; lint heuristics are hints, not proof of correctness.

User request: $@
