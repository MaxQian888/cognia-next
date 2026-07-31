# @cognia/memory

Framework-agnostic **long-term memory core** for Cognia — extracted from `lib/memory/` (ADR-0069).

This package holds the **dependency-injected, pure-algorithmic** half of the memory subsystem. It has
**zero `@/` app imports**: every DB / LLM / settings coupling is supplied by the caller through the deps
interfaces below. The app-side composition roots (`lib/memory/api/*`, `runtime/build-deps.ts`,
`lifecycle/*`, `write/*`, `external/*`) construct those deps from Dexie + the twin embedding backend and
call into this package.

## What's here

- `extract/` — LLM extraction of durable user facts (`extractMemories(input, client)`)
- `consolidate/` — LLM-judged ADD/UPDATE/DELETE/CONFLICT/NOOP consolidation (`ConsolidateDeps`)
- `retrieve/` — hybrid BM25 + vector retrieval (`retrieveMemories(input, MemoryRetrieverDeps)`) + scoring
- `forget/` — recency decay
- `control-plane/` — injection policy + contamination classification
- `runtime/apply-memory-context.ts` — the read-runtime system-prompt section builder (`ApplyMemoryContextDeps`)
- `procedural.ts`, `history-filter.ts`, `api/wire.ts` (external-surface row projection)
- `types/` — the `Memory` / governance type contracts (folded from `types/memory/`)
- `llm/` — the provider-agnostic `LlmClient` contract + `extractJson` helper (vendored)

## Consumers

Resolved **from source** in dev/test/build via root `tsconfig.json` paths + `jest.config.ts`
moduleNameMapper (never from `dist`). `dist` is produced by `tsup` only to prove standalone compilation.
