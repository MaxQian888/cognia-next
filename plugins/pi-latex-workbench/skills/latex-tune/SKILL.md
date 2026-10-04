---
name: latex-tune
description: Adjust LaTeX typography, floats, spacing or a specific page through the Pi LaTeX Workbench, comparing the affected pages before and after.
---

# LaTeX: tune layout

Follow the **latex-workbench** skill for tool mechanics (`stateDir`,
`project`, ops files, apply → materialize → build, approvals). Then:

1. Get a baseline: `latexwb_inspect`, then reuse the head's current build or
   `latexwb_build` it, and `latexwb_render_pages` the affected page plus the
   next one. Save the page images with `latexwb_artifact_save` and look at
   them.
2. Read `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-revise/references/guide.md`
   (“Tune layout”). For tables also
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-tables/references/guide.md`
   (fitting ladder; never `\resizebox` a table); for figures
   `${COGNIA_PLUGIN_ROOT}/vendor/resources/skills/latex-figures/references/guide.md`.
3. Locate the responsible source from the build diagnostics (overfull boxes
   carry file and line) and the page images. Change one local cause at a
   time — width, column structure, float placement, a paragraph break, a
   spacing setting the template already supports — through a governed patch.
4. Rebuild, render the same pages plus the adjacent flow, and compare with the
   baseline images. Content and numbers must stay intact; never hide overflow
   by clipping, deleting results or breaking template margins and font sizes.
5. Rendering needs the macOS arm64 render helper; if `latexwb_render_pages`
   reports it unavailable, say that the layout was not visually verified.

Report the layout delta, before/after page artifacts you actually viewed, and
anything that needs a protected or template change the operator must approve.

Apply this to the request the user made when invoking the skill.
