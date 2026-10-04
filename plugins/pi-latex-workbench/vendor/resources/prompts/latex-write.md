---
description: Draft or extend a LaTeX document from a writing brief
---
Use `skill:latex-project` via `latex_project resource`. Draft or extend the
requested document. Reuse existing structure and initialize only an empty
project, choosing the approved template that matches the document's language
and type (for Chinese text use a ctex-based template). Replace template
placeholders instead of appending, and write section by section. Ask only for
missing requirements that affect the result; continue ordinary writing with
`skill:latex-revise`. Never invent references, data or results: cite only
verified entries and mark illustrative numbers as such. Build, fix the first
causal error until the draft compiles, and return the PDF artifact unless the
user requested source-only work or formal release.

User request: $@
