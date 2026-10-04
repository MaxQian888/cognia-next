---
name: latex-revise
description: Local LaTeX drafting and revision. Use to write a section, polish wording, adjust layout or floats, make a follow-up tweak, or undo a specific earlier change while preserving document semantics.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Local revision

1. Establish the requested delta and current head using `latex_project inspect`. For a follow-up such as "make it shorter" or "move this figure", continue from the latest applied snapshot and existing target.
2. Read the owning files and necessary context. Separate new prose, wording edits, layout changes, and changes to scientific meaning. Complete this step when the smallest affected region and protected content are identified.
3. Propose the minimal coherent patch with `latex_patch propose`; inspect its diff, including line endings and blank lines. A blank line separates LaTeX paragraphs: preserve it during a sentence-only edit. Keep unrelated prose, preamble, bibliography, file structure, and formatting intact. Protected changes require host approval before `apply`.
4. Apply the authorized proposal and reread the changed region from the returned snapshot. Compare the actual replacement and surrounding paragraph boundaries with the baseline; repair any unintended delta before claiming completion. Then build that snapshot. For layout changes, inspect rendered pages and nearby reflow; for prose, check meaning and diagnostics. Stop when the requested delta has evidence.

For drafting, layout tuning, repeated edits, or undo, read [revision recipes](references/guide.md) through `latex_project resource` using `skill:latex-revise:guide`. Before the first patch, follow the snapshot/byte-offset protocol in `skill:latex-project:guide`.

Return a compact change summary, snapshot/target, build or preview artifact, and any remaining approval or verification gap. A local edit does not trigger a template migration, whole-document rewrite, or release package.
