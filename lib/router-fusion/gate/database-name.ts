/**
 * The Router + Fusion database's name, as a zero-import leaf (ADR-0188 D39).
 *
 * The fusion database is a sibling of the main database it belongs to:
 * `<main database>-router-fusion-v1`. Code that deletes a main database —
 * account deletion, runtime-target removal, the refused-layout reset, "clear
 * all data" — deletes the sibling with it, so ledger rows never outlive the
 * sessions they describe. Those modules sit on ordinary paths, so the name
 * lives here in `gate/` and pulls in nothing else.
 *
 * Only a database that can be the ACTIVE main database has a sibling: the
 * encrypted account and runtime-target databases, and the legacy no-account
 * database. A plaintext account or target database is only ever a migration
 * source in this build, so Router + Fusion never ran against one.
 */

export const FUSION_DB_SUFFIX = "-router-fusion-v1"

export function fusionDatabaseName(mainDatabaseName: string): string {
  if (!mainDatabaseName) throw new Error("fusionDatabaseName: main database name is required")
  return `${mainDatabaseName}${FUSION_DB_SUFFIX}`
}

export function isFusionDatabaseName(name: string): boolean {
  return name.endsWith(FUSION_DB_SUFFIX)
}

/** A main database followed by its fusion sibling, in deletion order. */
export function withFusionDatabase(mainDatabaseName: string): [string, string] {
  return [mainDatabaseName, fusionDatabaseName(mainDatabaseName)]
}
