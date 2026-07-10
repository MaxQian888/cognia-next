---
paths:
  - "docs/**"
---

# Docs site (Fumadocs) rules

- Import `@/lib/source` (NOT `@/app/source`); `collections/server` resolves via tsconfig alias to `docs/.source/` — run `pnpm docs:dev` once if TypeScript can't resolve it.
- `import { RootProvider } from "fumadocs-ui/provider/next"` — not `fumadocs-ui/provider`.
- `docs/.source/` is auto-generated (edits are hook-blocked) — regenerate via `pnpm docs:dev` / `pnpm docs:build`.
- Gate: `pnpm docs:build` is the only check that catches MDX prerender errors.
- Subsystem docs are bilingual under `docs/content/docs/{en,zh}/` — use the `subsystem-docs` skill; ADRs use the next free sequential number (`ls` the adr dir, take max + 1).
