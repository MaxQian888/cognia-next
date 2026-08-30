/**
 * @cognia/memory — the framework-agnostic long-term memory core.
 *
 * Every module here is dependency-injected: DB, LLM, settings, and the vector
 * backend are supplied by the caller through the deps interfaces, so this
 * package has ZERO `@/` app imports. The app-side composition roots under
 * `lib/memory/` (api/*, runtime/build-deps, lifecycle/*, write/*) construct
 * those deps from Dexie + the twin embedding backend and call in here.
 *
 * Subpath imports (`@cognia/memory/retrieve/retriever`, …) are the primary
 * surface — the boundary shims left at the old `@/lib/memory/*` paths use them.
 * This barrel is the convenience `.` export.
 */

// Type contracts
export * from "./types/memory"
export * from "./types/governance"

// LLM contract + JSON helper (vendored; concrete client stays app-side)
export * from "./llm"

// Retrieval
export * from "./retrieve/retriever"
export * from "./retrieve/scoring"
export * from "./retrieve/query-expansion"

// Write path: extraction + consolidation
export * from "./extract/extractor"
export * from "./extract/salience"
export * from "./extract/project-path-normalize"
export * from "./extract/project-windows"
export * from "./extract/project-salience"
export * from "./extract/project-extractor"
export * from "./consolidate/consolidator"

// Forgetting / decay
export * from "./forget/decay"

// Control plane: injection policy + contamination classification
export * from "./control-plane/policy"
export * from "./control-plane/contamination"

// Assembly + read runtime
export * from "./procedural"
export * from "./history-filter"
export * from "./runtime/apply-memory-context"
export * from "./runtime/provider-embedding-adapter"

// External-surface row projection
export * from "./api/wire"
