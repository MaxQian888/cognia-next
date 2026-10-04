---
name: latex-check
description: Review LaTeX source, compilation or layout through the Pi LaTeX Workbench without editing — draft lint, build diagnostics and rendered pages.
---

# LaTeX: check (read-only)

Follow the **latex-workbench** skill for tool mechanics (`stateDir`,
`project`). This review never proposes-and-applies, materializes, freezes or
packages anything.

1. `latexwb_inspect` the project. Reuse the head's current build (its
   artifacts are in `latexwb_jobs`) or `latexwb_build` it.
2. Start from machine evidence: `latexwb_check_run` with `ruleset: "draft"` on
   the PDF — undefined references, duplicate labels, citations missing from
   the bibliography, unused entries, floats without captions or labels,
   TODO/placeholder text, typography and build-log warnings, each with
   `path:line`.
3. Read the relevant source. For layout questions `latexwb_render_pages` the
   affected pages, save them with `latexwb_artifact_save` and look at them.
   Read the matching guide under
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/*/references/guide.md`
   (build-debug, tables, figures, bibliography) when it applies.
4. Report findings and proposed fixes (as suggested wording or diffs), kept
   apart by source: lint findings, build diagnostics, your own reading of the
   source, and pages you actually saw. Lint heuristics are hints, not proof
   of correctness; anything unverifiable is `needs-review`.

Apply this to the request the user made when invoking the skill.
