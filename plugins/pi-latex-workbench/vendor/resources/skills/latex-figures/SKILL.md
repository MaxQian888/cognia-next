---
name: latex-figures
description: Figure work in LaTeX. Use to reuse or resize an existing image, adjust a caption or float, generate a plot from supplied data, or create a conceptual diagram.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Figure work

1. Classify the request: reuse/layout, data plot, or conceptual diagram. Inspect current source, selected target, and the actual assets; keep original scientific images intact.
2. For placement, width, or caption-only changes, edit the existing figure locally through `latex_patch`; regeneration is unnecessary. For a new generated asset, use `latex_figure plot` or `diagram` with a current snapshot asset ID and an approved recipe.
3. Inspect generation diagnostics, provenance, and compile proof. Attach the returned same-project artifact with `attach-asset` and wire its inclusion/caption/label in a coherent proposal; generation alone does not put it in the document.
4. Build the applied snapshot and inspect the affected pages at their final size. Verify legible labels, unclipped content, captions, references, and nearby float movement.

Read [figure recipes](references/guide.md) using resource `skill:latex-figures:guide` when generating, replacing, or tuning a figure. Use `skill:latex-project:guide` for patch and approval mechanics.

Report source/recipe provenance and actual artifact references. Generated illustrations may be conceptual; they cannot stand in for missing experimental evidence.
