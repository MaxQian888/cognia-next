/**
 * Boundary shim — these type contracts moved into `@cognia/memory` so the
 * memory core has zero app imports. Kept so the ~80 existing
 * `@/types/memory/memory` importers stay unchanged.
 */
export * from "@cognia/memory/types/memory"
