---
name: subsystem-docs
description: Write or renovate a bilingual multi-page Fumadocs subsystem section under docs/content/docs/{en,zh}/. Use when documenting a subsystem, replacing a stale docs page, or adding ADR-backed docs. Encodes the established canvas-section workflow and every known MDX build trap for this repo.
---

# Subsystem Docs (bilingual Fumadocs canvas section)

The repeatable workflow for replacing a stale single page with a multi-page,
implementation-accurate, bilingual docs section. Pages live under
`docs/content/docs/en/<area>/<name>/` and `docs/content/docs/zh/<area>/<name>/`
(e.g. `subsystems/ocr/`), each side with its own `meta.json`.

## Workflow

1. **Map before writing.** Dispatch parallel read-only mapping agents, one per
   planned page. Each must return line-accurate references (`file.ts:line`),
   real code snippets, and a mermaid diagram sketch. Never write docs from the
   ADR alone — ADRs drift.
2. **Document drift explicitly.** Where the implementation diverges from the
   ADR, the docs describe the *implementation* and call out the divergence
   (e.g. "ADR-0024 specifies 4 commands; the implementation registers 5").
   Verify every count (tables, commands, adapters, schema version) against
   source before stating it.
3. **Structure.** `index.mdx` (overview + mermaid of the whole subsystem) plus
   one page per plane/topic. Add every page to `meta.json` on **both** language
   sides. Preserve existing slugs when replacing a page so inbound links
   survive; otherwise grep all of `docs/content/` for the old slug and rewire.
4. **Translate.** zh pages are full translations, not summaries. Keep code
   blocks, identifiers, and paths in English.
5. **Verify.** `rtk pnpm docs:build` is the ONLY gate that catches MDX
   prerender errors. Record the page count and confirm it grew by the expected
   number. `docs/.source/` is auto-generated — never edit it.

## MDX build traps (every one of these has burned a session)

- **Escaped backtick**: `` \` `` inside an inline code span compiles in dev but
  breaks `next build` with a JSX ReferenceError. Use a code fence instead.
- **`<Status/>` inline in an ATX heading** (`# Title <Status/>`): compiles, but
  `next build` explodes during /api/search page-data collection with
  "Status is not defined". Put the JSX on its own line below the heading.
- **`{...}` inside `<Status>` children** and pipe-in-table-with-backtick
  combos: MDX prerender ReferenceError. Only `docs:build` catches these.
- **Subagent output leakage**: translation agents have leaked literal
  `</content>` tags into MDX. Always `tail` each generated file and run
  `docs:build` before claiming done.
- **mermaid erDiagram**: entity attributes must each be on their own line.

## Import conventions (docs workspace)

- `@/lib/source` (NOT `@/app/source`); `collections/server` (tsconfig alias →
  `.source/`); `fumadocs-ui/provider/next`.
- If TS can't resolve `collections/server`, run `pnpm docs:dev` or
  `pnpm docs:build` once to regenerate `docs/.source/`.
