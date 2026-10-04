---
name: latex-write
description: Draft or extend a LaTeX document from a writing brief through the Pi LaTeX Workbench, then build it to a draft PDF.
---

# LaTeX: write

Follow the **latex-workbench** skill for tool mechanics (`stateDir`,
`project`, ops files, apply → materialize → build, approvals). Then:

1. `latexwb_inspect` the project. Reuse its existing structure, class,
   preamble, macros and bibliography backend. Only when the user asks for a
   new document and no project exists, start from the approved template that
   matches the language and document type (for Chinese text a ctex-based
   template: `zh-article`, `zh-thesis`, `zh-beamer`) as the latex-workbench
   skill describes, and replace its placeholder text instead of appending.
2. Read `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-revise/references/guide.md`
   (“Draft or extend text”) and, before the first patch,
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-project/references/guide.md`.
3. Write section by section: one governed proposal per section or file, so a
   failing build points at a small region. Ask only for missing requirements
   that change the result; otherwise follow the document's conventions.
4. Never invent references, data or results. Cite only entries that exist in
   the project's bibliography or that the user supplied; mark illustrative
   numbers as illustrative. New equations, labels and citations are protected
   additions: in strict mode each such patch needs the operator's grant —
   batch them so one grant covers a coherent section, and give the user the
   exact `approve` command.
5. After each applied proposal: materialize, `latexwb_build`, fix the first
   causal error until the draft compiles, then `latexwb_check_run` with
   `ruleset: "draft"`.
6. Return the PDF (`latexwb_artifact_save` to where the user wants it) unless
   the user asked for source only or for a formal release.

Apply this to the request the user made when invoking the skill.
