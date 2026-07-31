/**
 * Boundary shim — the implementation moved into `@cognia/memory` (the pure,
 * dependency-injected memory core). Kept so existing `@/lib/memory/extract/extractor`
 * importers stay unchanged; the app-side composition roots (api/*, build-deps,
 * lifecycle/*, write/*, run-turn-memory) keep importing from here.
 */
export * from "@cognia/memory/extract/extractor"
