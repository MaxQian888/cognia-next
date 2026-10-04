---
name: latex-template
description: Template selection or migration for LaTeX documents. Use to start with an approved class, change document format, or meet a specified institution or venue requirement.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Template selection and migration

1. Determine whether this is a new document, an explicit template migration, or a local layout request. Route local tuning to `latex-revise` and preserve the existing template.
2. For generic writing, use the document type, language, and approved template already chosen. For regulated submissions, identify the institution/venue, year, track, and stage before claiming compliance.
3. Inspect current source and map class options, macros, included files, bibliography backend, engine, and assets to the proposed template. Finish the plan when preserved content and required compatibility changes are explicit.
4. Use approved `latex_project init` only for a new project. Migrate existing files using a scoped patch and host approval, preserving a baseline snapshot.
5. After application, clean-build affected targets and review representative pages plus every impacted structural region. Formal readiness requires `latex-release`; ordinary template setup ends with usable draft output.

For source verification and migration checks, read [template recipes](references/guide.md) using resource `skill:latex-template:guide`. Apply edits with the protocol in `skill:latex-project:guide`.
