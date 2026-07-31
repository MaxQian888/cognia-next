/**
 * Boundary shim — these type contracts moved into `@cognia/memory` so the
 * memory core has zero app imports. Kept so the ~80 existing
 * `@/types/memory/governance` importers stay unchanged.
 */
export * from "@cognia/memory/types/governance"
