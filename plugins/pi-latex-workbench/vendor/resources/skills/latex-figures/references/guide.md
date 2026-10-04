# Figure recipes

## Reuse and local tuning

Read the figure environment and relevant macros, then use the existing asset path. Preserve legitimate PDF/vector images and avoid unnecessary format conversion. Width should be relative to the containing column or text area as appropriate; a float moved elsewhere may affect adjacent pages. Caption edits preserve units, uncertainty, measurement conditions, labels, and scientific meaning.

A replacement asset must already be registered in the same project. `attach-asset` requires the existing file hash when replacing it. Do not delete or overwrite raw source assets just because a derived image exists.

## Plot supplied data

Find `sourceAssetId` in the inspected snapshot's assets, then read the actual data and column meanings. `latex_figure plot` requires `recipeId` and `params` containing `xField`, `yFields`, `errorField` (or null), axis labels, title, `widthMm`, and `heightMm`. Choose fields and units from the source; never infer missing measurements or uncertainty values.

Recipes take closed parameters, not injected scripts. Retain data, recipe, and parameter hashes from returned provenance. Inspect the numeric mapping artifact and use `latex_check run` with `rulesetId: "data-assets"` on the generated artifact when numeric fidelity is relevant. A successful tool execution may still report failed or skipped compile proof.

## Conceptual diagrams

`latex_figure diagram` accepts an approved `recipeId`, a snapshot `sourceAssetId`, and a `diagramSpec`: supported kind, nodes, edges, caption, and `stylePresetId`. Use real source IDs, not an invented placeholder. Mark the result conceptual and ensure arrows, labels, and topology express the supplied explanation. If the source asset or approved recipe is missing, report that prerequisite rather than fabricating it.

## Integration and review

Inspect the generated text/artifact type before choosing `\input` versus `\includegraphics`; use only the representation the tool actually produced. Attach the required artifact and any textual integration through one proposal where practical. Observe protected data, label, caption-semantics, and macro approval gates.

Build the complete target after integration even if the standalone asset compiled. Render the figure's page and neighboring pages affected by floats. Check actual returned images, requesting smaller batches if truncated. Provenance and compilation establish reproducibility, not scientific validity of the source data.
