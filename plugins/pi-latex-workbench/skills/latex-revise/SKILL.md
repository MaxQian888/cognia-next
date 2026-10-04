---
name: latex-revise
description: Revise selected LaTeX text through the Pi LaTeX Workbench with the smallest governed patch, preserving meaning, values, citations and unrelated content.
---

# LaTeX: revise

Follow the **latex-workbench** skill for tool mechanics (`stateDir`,
`project`, ops files, apply → materialize → build, approvals). Then:

1. Establish the requested delta and the current head with `latexwb_inspect`.
   A follow-up (“make it shorter”, “move this figure”) continues from the
   latest applied snapshot and its target — never from an older import.
2. Read the owning files and the context they need. Read
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-revise/references/guide.md`
   and, before the first patch,
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-project/references/guide.md`.
3. Make the smallest revision that satisfies the request. Preserve
   mathematical meaning, values, citation keys, labels, file boundaries,
   formatting and blank lines outside the edited region. A wording change
   that strengthens a claim (“associated with” → “causes”, a quantifier, an
   assumption, uncertainty) changes meaning: present it for review instead of
   applying it as polish.
4. Propose with `replace` operations copied verbatim from the latest read,
   inspect the diff, apply, materialize, then re-read the changed region and
   compare it with the baseline before claiming success. A protected change
   stops at `POLICY_DENIED` until the operator grants it.
5. Build the resulting snapshot and verify proportionally: prose needs a clean
   build and unchanged meaning; layout needs rendered pages.

Return a compact change summary, the snapshot and target, the build artifact,
and any approval or verification still open.

Apply this to the request the user made when invoking the skill.
