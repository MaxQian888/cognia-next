/**
 * Public status: the import path the page and Settings use.
 *
 * Re-exports the v1 contract (`contract.ts`), its derivation rules
 * (`derive.ts`), boundary parsers (`validate.ts`) and runtime config
 * (`config.ts`). The standalone services import those leaf files directly by
 * relative path; app code imports this barrel. Preview data no longer lives
 * here: fixtures are in `fixtures.ts` and only tests and stories import them.
 */

export * from "./contract"
export * from "./derive"
export * from "./validate"
export * from "./config"

/** Newest first, without mutating the source list. */
export function sortIncidentUpdatesNewestFirst<T extends { at: string }>(
  updates: readonly T[]
): T[] {
  return [...updates].sort((left, right) => right.at.localeCompare(left.at))
}
