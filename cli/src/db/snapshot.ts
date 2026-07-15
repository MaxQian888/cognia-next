/**
 * Pure (de)serialisation of the CLI's local Dexie store to/from a JSON snapshot
 * file. Kept free of fake-indexeddb + `getDb` so it unit-tests against any
 * DB-like object; the orchestration that installs globals and opens the real
 * `CogniaDB` lives in `bootstrap.ts`.
 */

/** The minimal Dexie surface the snapshot logic needs. */
export interface DbTableLike {
  name: string
  toArray(): Promise<unknown[]>
  clear(): Promise<unknown>
  bulkPut(rows: unknown[]): Promise<unknown>
}

export interface DbLike {
  verno: number
  tables: DbTableLike[]
}

export interface DbSnapshot {
  version: number
  tables: Record<string, unknown[]>
}

export type SnapshotParseResult =
  { kind: "absent" } | { kind: "corrupt"; reason: string } | { kind: "valid"; snapshot: DbSnapshot }

export class SnapshotVersionMismatchError extends Error {
  readonly snapshotVersion: number
  readonly databaseVersion: number

  constructor(snapshotVersion: number, databaseVersion: number) {
    super(
      `Snapshot schema version ${snapshotVersion} does not match database schema version ${databaseVersion}.`
    )
    this.name = "SnapshotVersionMismatchError"
    this.snapshotVersion = snapshotVersion
    this.databaseVersion = databaseVersion
  }
}

/** Dump every table to a snapshot keyed by table name. */
export async function serializeDb(db: DbLike): Promise<DbSnapshot> {
  const tables: Record<string, unknown[]> = {}
  for (const table of db.tables) {
    tables[table.name] = await table.toArray()
  }
  return { version: db.verno, tables }
}

/**
 * Overlay snapshot rows onto the (already-opened, already-seeded) db. Tables the
 * snapshot omits keep their seeded rows; snapshot tables absent from the current
 * schema are ignored.
 */
export async function restoreSnapshot(db: DbLike, snapshot: DbSnapshot): Promise<void> {
  if (snapshot.version !== db.verno) {
    throw new SnapshotVersionMismatchError(snapshot.version, db.verno)
  }
  for (const table of db.tables) {
    const rows = snapshot.tables[table.name]
    if (!rows) continue
    await table.clear()
    if (rows.length > 0) await table.bulkPut(rows)
  }
}

/** Parse snapshot JSON while preserving the absent-versus-corrupt distinction. */
export function parseSnapshot(text: string | null | undefined): SnapshotParseResult {
  if (text === null || text === undefined) return { kind: "absent" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "corrupt", reason: "invalid JSON" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt", reason: "snapshot root is not an object" }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.version !== "number" || !Number.isFinite(obj.version)) {
    return { kind: "corrupt", reason: "snapshot version is not a finite number" }
  }
  if (!obj.tables || typeof obj.tables !== "object" || Array.isArray(obj.tables)) {
    return { kind: "corrupt", reason: "snapshot tables are not an object" }
  }
  const tables = obj.tables as Record<string, unknown>
  if (Object.values(tables).some((rows) => !Array.isArray(rows))) {
    return { kind: "corrupt", reason: "one or more snapshot tables are not arrays" }
  }
  return {
    kind: "valid",
    snapshot: { version: obj.version, tables: tables as Record<string, unknown[]> },
  }
}

export function serializeSnapshot(snapshot: DbSnapshot): string {
  return JSON.stringify(snapshot)
}
