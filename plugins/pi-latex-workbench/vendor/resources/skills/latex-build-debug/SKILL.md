---
name: latex-build-debug
description: Build diagnosis for LaTeX compile errors, unresolved references, missing fonts or dependencies, and stale PDFs. Use for a failing target or a regression after a source change.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Build diagnosis

1. Inspect the current head and selected target. Reuse a failing build only if its snapshot and target match; otherwise run `latex_build run` to reproduce. A PDF found in the imported directory is not a successful current build.
2. Read structured diagnostics and the relevant full log ranges via `latex_project artifact-read`. Locate the first causal error in source, including included files and macro definitions.
3. Separate a source defect from missing runtime, package/font, or host capability. For a source defect, propose one small repair; preserve scientific content and observe host approval gates.
4. After `apply`, build the returned snapshot and compare the original failure. Review pages when the repair changes output. Stop when the fault is resolved or evidence points to a host blocker.

For error-specific investigation and retry limits, read [debugging recipes](references/guide.md) using resource `skill:latex-build-debug:guide`. Use `skill:latex-project:guide` for snapshot and patch mechanics.

Report the cause, patch, real build status, artifact/log references, and residual warnings. Compilation and visual review are separate results; a completed tool call can still contain a failed build.
