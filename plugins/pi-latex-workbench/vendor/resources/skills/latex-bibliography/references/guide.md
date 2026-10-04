# Bibliography recipes

## Existing references

Read all relevant `.bib` files and citation sites across included chapters. Respect existing keys, capitalization braces, Unicode names, required fields, entry types, and the chosen BibTeX/biber/manual bibliography workflow. An unresolved key may be a typo in a citation or an omitted data file; do not invent an entry to silence it.

Use `latex_bib audit` only with existing nonempty bibliography paths. For an inline `thebibliography` or supplied `.bbl`, inspect source directly; the `.bib` audit is not a mandate to convert formats. A key rename must update every affected citation in one coherent proposal and retains protected-content approval.

## Adding or correcting metadata

`lookup` returns real candidate IDs and provider diagnostics. Read the returned source evidence; distinguish a preprint, conference version, journal version, and correction. Missing provider access means unavailable, not "the publication does not exist". Never fill missing author names, titles, dates, pages, or identifiers from plausible memory.

`propose-import` targets one `bibPath` in the current base snapshot. Review the exact proposed entry and conflicts before apply. If it returns no proposal, report no change; do not manufacture a patch ID. Preserve established keys unless a deliberate migration is requested. New citation commands in prose are a separate protected source change and must refer to an actually present or approved imported entry.

## Claim support

Metadata confirms identity, not scientific support. Assess a claim only against text actually accessible through approved sources; record the relevant passage and any scope limits. If full text is unavailable, mark the claim unreviewed. If the source contradicts the draft, describe the mismatch and propose a reviewable wording change rather than strengthening or fabricating evidence.

After application, rebuild the selected target and check citation/reference diagnostics. Preserve prior verified entries when provider access fails; report the offline verification boundary.
