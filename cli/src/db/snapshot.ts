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
  for (const table of db.tables) {
    const rows = snapshot.tables[table.name]
    if (!rows) continue
    await table.clear()
    if (rows.length > 0) await table.bulkPut(rows)
  }
}

/** Parse snapshot JSON, returning null for missing/invalid/wrong-shape input. */
export function parseSnapshot(text: string | null | undefined): DbSnapshot | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.version !== "number") return null
  if (!obj.tables || typeof obj.tables !== "object") return null
  return { version: obj.version, tables: obj.tables as Record<string, unknown[]> }
}

export function serializeSnapshot(snapshot: DbSnapshot): string {
  return JSON.stringify(snapshot)
}
