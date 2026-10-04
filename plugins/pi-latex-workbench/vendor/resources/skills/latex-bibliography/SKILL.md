---
name: latex-bibliography
description: Bibliography maintenance for LaTeX. Use to add verified references, diagnose missing citation keys, repair BibTeX metadata, or assess the evidence behind a cited claim.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Bibliography maintenance

1. Inspect the current snapshot and bibliography paths; read the affected citation sites and entries. A document without citations needs no bibliography work unless requested.
2. Use `latex_bib audit` with actual `bibPaths` for local consistency. For a requested addition or verification, use `lookup` with either `query` or `identifier` through an approved provider.
3. Inspect candidate provenance, metadata, and version. Use `propose-import` with `baseSnapshotId`, `bibPath`, and returned `candidateIds`; it creates a proposal, not an applied change.
4. Read the diff and resolve key collisions or protected edits through the host gate. Apply the authorized patch, then build the new snapshot using the existing bibliography backend.

For offline, imported, or claim-review cases, read [bibliography recipes](references/guide.md) using resource `skill:latex-bibliography:guide`. Use `skill:latex-project:guide` for source mutation mechanics.

Report metadata verification, local consistency, compile outcome, and claim support separately. A real DOI or successful build does not establish that a paper supports the sentence citing it.
