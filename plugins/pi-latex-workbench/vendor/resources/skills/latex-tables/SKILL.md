---
name: latex-tables
description: Table work in LaTeX. Use to format an existing table, adjust width or pagination, or generate a table from supplied structured data with explicit units and rounding.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Table work

1. Distinguish layout-only editing from data generation or correction. Read the current table, its source data when available, units, precision, notes, and surrounding document constraints.
2. For layout, preserve existing cell values and edit the smallest region. For generation, use `latex_figure table` with a real `sourceAssetId`, the current `snapshotId`, and an explicit `tableSpec` derived from the data.
3. Inspect numeric mapping and compile diagnostics. Integrate generated content with `attach-asset` or a verified text patch; keep source-to-display mapping. Protected values, labels, citations, and macros retain host approval gates.
4. Build the resulting snapshot and render the table plus affected neighboring pages. Finish when width, alignment, headers, notes, pagination, and requested data fidelity have been checked.

Read [table recipes](references/guide.md) using resource `skill:latex-tables:guide` for precision choices, integration, or wide/long tables. Use `skill:latex-project:guide` for snapshot and patch mechanics.

Report the exact layout/data delta and any unverified source values. Formatting never licenses changing results or fabricating missing cells.
