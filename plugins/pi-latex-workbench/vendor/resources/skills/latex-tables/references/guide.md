# Table recipes

## Existing table layout

Read the owning `.tex` file and macros defining its columns. Preserve cell values, row identities, units, missing-value markers, captions, notes, and labels. Improve column widths, text wrapping, alignment, or supported multi-page structure before shrinking text globally. Reuse packages/environments already supported by the target; a new package dependency may require host provisioning.

For a wide table, check the actual text/column width and whether wrapping, splitting by a meaningful group, or an approved landscape environment fits the user's intent. Work down this ladder and stop at the first step that fits:

1. shorten headers (abbreviate, move units into a second header row or the caption: `Acc. (\%)`, `Latency (ms)`), and wrap long headers with `\makecell{…\\…}` or a `p{…}`/`tabularx` `X` column instead of `\shortstack`;
2. reduce `\tabcolsep` modestly and use one table-wide size step (`\small`, at most `\footnotesize`) — the table body should not be smaller than its caption;
3. `tabular*`/`tabularx` at `\linewidth` to distribute width across columns;
4. transpose or split the table by a meaningful group, or a landscape page, when the content is genuinely too wide.

Avoid `\resizebox`/`\scalebox` on tables: they produce off-scale font sizes and thinned rules that no longer match the document. Right-align or decimal-align numeric columns (`r`, or `siunitx` `S` when the package is available) rather than centring them. For a long table, inspect repeated headers, continuation captions, footnotes, and page breaks. Do not replace missing data with zeros or remove uncertainty columns to make it fit.

## Generate from structured data

Take `sourceAssetId` from the current inspection and read the source first. `latex_figure table` requires `tableSpec.columns` with `field`, `label`, `unit` (or null), and `decimalPlaces` (or null), plus `roundingMode` (`half-even` or `half-up`), `missingValue`, `caption`, and `label`. Preserve an established rounding policy; if a new choice affects interpretation, expose it before presenting a finished scientific table.

Keep raw and displayed values distinct. Missing units or unexplained error quantities are review items, not opportunities to guess. Standard deviation, standard error, confidence intervals, and sample counts have different meanings and must remain explicit.

## Integrate and verify

Read generated TeX and mapping artifacts with `artifact-read`. Attach the appropriate registered text asset or create a scoped text patch, preserving required package compatibility and document include structure. Generation returns artifacts but does not modify the source snapshot. After `apply`, build the new snapshot.

Use `latex_check run` with `rulesetId: "data-assets"` against the generated artifact for numeric mapping verification. Inspect source-to-cell correspondence in addition to compilation. A layout-only edit of a manually maintained table uses direct before/after cell comparison; regeneration is unnecessary.

Render all table pages and affected adjacent pages. Verify no clipped columns, lost rows, illegible scaling, missing continuation headers, or detached notes. If the runtime cannot compile/render, retain the patch and provenance while reporting the unverified portion accurately.
