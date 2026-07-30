/**
 * Pure (de)serialisation of the CLI's local Dexie store to/from a JSON snapshot
 * file. Kept free of fake-indexeddb + `getDb` so it unit-tests against any
 * DB-like object; the orchestration that installs globals and opens the real
 * databases lives in `bootstrap.ts`.
 *
 * The app spans TWO Dexie databases — `CogniaDB` (`lib/db/schema.ts`) and the
 * scheduler's own `CogniaSchedulerDB` (`lib/scheduler/scheduler-db.ts`) — so the
 * envelope is keyed by database name (`MultiDbSnapshot`). Snapshots written
 * before that change are single-database and have no `snapshotFormat` key;
 * `parseMultiSnapshot` normalises them onto the primary database so an existing
 * `~/.cognia/serve/db-*.json` keeps restoring after an upgrade.
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
  /** Dexie exposes this; used as the `MultiDbSnapshot.dbs` key. */
  name?: string
  /** Dexie exposes this; awaited so middleware attaches before the first open. */
  open?(): Promise<unknown>
}

export interface DbSnapshot {
  version: number
  tables: Record<string, unknown[]>
}

/** Snapshot envelope spanning every database the host persists. */
export interface MultiDbSnapshot {
  /** Envelope format. Absent on legacy single-database snapshots. */
  snapshotFormat: 2
  /** Keyed by Dexie database name (`CogniaDB`, `CogniaSchedulerDB`, …). */
  dbs: Record<string, DbSnapshot>
}

/** One database to snapshot, plus the tables deliberately left out of it. */
export interface SnapshotSource {
  /** Dexie database name — the `MultiDbSnapshot.dbs` key. */
  name: string
  db: DbLike
  /**
   * Tables excluded from the snapshot on purpose. High-churn history that the
   * host can rebuild or does not need across restarts belongs here — every
   * excluded table must be documented at its own definition site (Working
   * Rule 7) and pinned by a test.
   */
  excludeTables?: readonly string[]
}

export type SnapshotParseResult =
  { kind: "absent" } | { kind: "corrupt"; reason: string } | { kind: "valid"; snapshot: DbSnapshot }

export type MultiSnapshotParseResult =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: string }
  | { kind: "valid"; snapshot: MultiDbSnapshot }

export class SnapshotVersionMismatchError extends Error {
  readonly snapshotVersion: number
  readonly databaseVersion: number
  /** Which database mismatched, when restoring a multi-database snapshot. */
  readonly databaseName: string | null

  constructor(snapshotVersion: number, databaseVersion: number, databaseName?: string) {
    super(
      `Snapshot schema version ${snapshotVersion} does not match database schema version ${databaseVersion}${
        databaseName ? ` (database ${databaseName})` : ""
      }.`
    )
    this.name = "SnapshotVersionMismatchError"
    this.snapshotVersion = snapshotVersion
    this.databaseVersion = databaseVersion
    this.databaseName = databaseName ?? null
  }
}

/** Dump every table (minus `excludeTables`) to a snapshot keyed by table name. */
export async function serializeDb(
  db: DbLike,
  opts: { excludeTables?: readonly string[] } = {}
): Promise<DbSnapshot> {
  const excluded = new Set(opts.excludeTables ?? [])
  const tables: Record<string, unknown[]> = {}
  for (const table of db.tables) {
    if (excluded.has(table.name)) continue
    tables[table.name] = await table.toArray()
  }
  return { version: db.verno, tables }
}

/** Dump every source database into one envelope. */
export async function serializeSources(
  sources: readonly SnapshotSource[]
): Promise<MultiDbSnapshot> {
  const dbs: Record<string, DbSnapshot> = {}
  for (const source of sources) {
    dbs[source.name] = await serializeDb(source.db, { excludeTables: source.excludeTables })
  }
  return { snapshotFormat: 2, dbs }
}

/**
 * Overlay snapshot rows onto the (already-opened, already-seeded) db. Tables the
 * snapshot omits keep their seeded rows; snapshot tables absent from the current
 * schema are ignored.
 */
export async function restoreSnapshot(
  db: DbLike,
  snapshot: DbSnapshot,
  databaseName?: string
): Promise<void> {
  if (snapshot.version !== db.verno) {
    throw new SnapshotVersionMismatchError(snapshot.version, db.verno, databaseName)
  }
  for (const table of db.tables) {
    const rows = snapshot.tables[table.name]
    if (!rows) continue
    await table.clear()
    if (rows.length > 0) await table.bulkPut(rows)
  }
}

/**
 * Overlay a multi-database snapshot onto its sources.
 *
 * A database the envelope omits is SKIPPED, not cleared — same semantics as an
 * omitted table, one level up. That is what makes the upgrade path work: the
 * first boot after this change reads a legacy single-database file, so
 * `CogniaSchedulerDB` has no entry and simply starts from its seeded state.
 */
export async function restoreMultiSnapshot(
  sources: readonly SnapshotSource[],
  snapshot: MultiDbSnapshot
): Promise<void> {
  for (const source of sources) {
    const perDb = snapshot.dbs[source.name]
    if (!perDb) continue
    await restoreSnapshot(source.db, perDb, source.name)
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

/**
 * Parse either envelope format and normalise to {@link MultiDbSnapshot}.
 *
 * `primaryDbName` is the key a legacy single-database snapshot is filed under —
 * pass the name of the database that legacy snapshots were dumped from
 * (`CogniaDB`). Only reached for files without a `snapshotFormat` key.
 */
export function parseMultiSnapshot(
  text: string | null | undefined,
  primaryDbName: string
): MultiSnapshotParseResult {
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

  // Legacy single-database envelope — no `snapshotFormat` key.
  if (obj.snapshotFormat === undefined) {
    const legacy = parseSnapshot(text)
    if (legacy.kind !== "valid") return legacy
    return {
      kind: "valid",
      snapshot: { snapshotFormat: 2, dbs: { [primaryDbName]: legacy.snapshot } },
    }
  }

  if (obj.snapshotFormat !== 2) {
    return { kind: "corrupt", reason: `unsupported snapshot format ${String(obj.snapshotFormat)}` }
  }
  if (!obj.dbs || typeof obj.dbs !== "object" || Array.isArray(obj.dbs)) {
    return { kind: "corrupt", reason: "snapshot dbs are not an object" }
  }
  const dbs: Record<string, DbSnapshot> = {}
  for (const [name, value] of Object.entries(obj.dbs as Record<string, unknown>)) {
    const perDb = parsePerDbSnapshot(value)
    if (!perDb) return { kind: "corrupt", reason: `snapshot for database ${name} is malformed` }
    dbs[name] = perDb
  }
  return { kind: "valid", snapshot: { snapshotFormat: 2, dbs } }
}

/** Validate one `dbs[name]` entry. Returns null when malformed. */
function parsePerDbSnapshot(value: unknown): DbSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.version !== "number" || !Number.isFinite(entry.version)) return null
  if (!entry.tables || typeof entry.tables !== "object" || Array.isArray(entry.tables)) return null
  const tables = entry.tables as Record<string, unknown>
  if (Object.values(tables).some((rows) => !Array.isArray(rows))) return null
  return { version: entry.version, tables: tables as Record<string, unknown[]> }
}

export function serializeSnapshot(snapshot: DbSnapshot | MultiDbSnapshot): string {
  return JSON.stringify(snapshot)
}
