---
"cognia-next": minor
---

The Cognia Office workbook plugin now supports structural row and column editing — agents can insert or delete rows and columns and the model remaps cells, merges, filters, freeze panes, and dimensions to match Excel semantics. Cell and range references are validated against real worksheet bounds and normalized to uppercase, so previously accepted invalid references like `A0`, `XFE1`, or `:::` now fail cleanly.

The workbook preview was rebuilt as a spreadsheet: column letters and row numbers, sticky frozen panes with accent edges, filter indicators, sheet tabs with Filtered/Frozen badges, number and date formatting, formula tooltips, and bounded rendering for very large sheets. Import now warns about a much wider set of OOXML features that cannot round-trip (media, comments, tables, data validation, conditional formatting, hyperlinks, protection), exported dates carry a default number format, and `office_sync_lark` can target a Lark Drive folder.
