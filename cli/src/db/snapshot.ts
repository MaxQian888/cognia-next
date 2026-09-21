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

import { Buffer } from "node:buffer"

const BINARY_CHUNK_BYTES = 64 * 1024
const SNAPSHOT_VALUE_KEY = "$cogniaSnapshotValue"

export type SnapshotBinary = Blob | Uint8Array | ArrayBuffer
export interface SnapshotBinaryStore {
  write?: (value: SnapshotBinary) => Promise<string>
  read?: (reference: string, byteLength: number) => Uint8Array<ArrayBuffer>
  readBlob?: (reference: string, byteLength: number, mediaType: string) => Promise<Blob>
}

/** Encode source bytes in bounded chunks; Blob.toJSON otherwise silently writes {}. */
async function encodeSnapshotValue(
  value: unknown,
  ancestors = new Set<object>(),
  binaryStore?: SnapshotBinaryStore
): Promise<unknown> {
  if (!value || typeof value !== "object") return value
  if (value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const byteLength = value instanceof Blob ? value.size : value.byteLength
    if (binaryStore?.write)
      return {
        [SNAPSHOT_VALUE_KEY]: {
          version: 1,
          type:
            value instanceof Blob
              ? "blob"
              : value instanceof Uint8Array
                ? "uint8array"
                : "arraybuffer",
          byteLength,
          ...(value instanceof Blob ? { mediaType: value.type } : {}),
          fileRef: await binaryStore.write(value),
        },
      }
    const chunks: string[] = []
    for (let offset = 0; offset < byteLength; offset += BINARY_CHUNK_BYTES) {
      const bytes =
        value instanceof Blob
          ? new Uint8Array(await value.slice(offset, offset + BINARY_CHUNK_BYTES).arrayBuffer())
          : value instanceof Uint8Array
            ? value.subarray(offset, offset + BINARY_CHUNK_BYTES)
            : new Uint8Array(value, offset, Math.min(BINARY_CHUNK_BYTES, byteLength - offset))
      chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"))
    }
    return {
      [SNAPSHOT_VALUE_KEY]: {
        version: 1,
        type:
          value instanceof Blob
            ? "blob"
            : value instanceof Uint8Array
              ? "uint8array"
              : "arraybuffer",
        byteLength,
        ...(value instanceof Blob ? { mediaType: value.type } : {}),
        chunks,
      },
    }
  }
  if (value instanceof Date) return value.toJSON()
  if (ancestors.has(value)) throw new TypeError("Cannot snapshot a cyclic value")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const item of value) result.push(await encodeSnapshotValue(item, ancestors, binaryStore))
      return result
    }
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value))
      entries.push([key, await encodeSnapshotValue(item, ancestors, binaryStore)])
    // User/plugin objects may use any property name, including the codec tag.
    // Escape those records so they never acquire binary semantics on restore.
    return Object.hasOwn(value, SNAPSHOT_VALUE_KEY)
      ? { [SNAPSHOT_VALUE_KEY]: { version: 1, type: "record", entries } }
      : Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}

function decodeSnapshotValue(
  value: unknown,
  materialize = true,
  binaryStore?: SnapshotBinaryStore
): unknown {
  if (!value || typeof value !== "object") return value
  if (value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer)
    return value
  if (Array.isArray(value))
    return value.map((item) => decodeSnapshotValue(item, materialize, binaryStore))
  const object = value as Record<string, unknown>
  if (Object.keys(object).length === 1 && Object.hasOwn(object, SNAPSHOT_VALUE_KEY)) {
    const envelope = object[SNAPSHOT_VALUE_KEY]
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error("invalid snapshot value envelope")
    const data = envelope as Record<string, unknown>
    if (data.version !== 1) throw new Error("unsupported snapshot value version")
    if (data.type === "record") {
      if (
        !Array.isArray(data.entries) ||
        data.entries.some(
          (entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
        )
      )
        throw new Error("invalid escaped snapshot record")
      return Object.fromEntries(
        data.entries.map(([key, item]: [string, unknown]) => [
          key,
          decodeSnapshotValue(item, materialize, binaryStore),
        ])
      )
    }
    if (
      !["blob", "uint8array", "arraybuffer"].includes(String(data.type)) ||
      !Number.isSafeInteger(data.byteLength) ||
      (data.byteLength as number) < 0 ||
      (data.fileRef === undefined &&
        (!Array.isArray(data.chunks) ||
          data.chunks.length !== Math.ceil((data.byteLength as number) / BINARY_CHUNK_BYTES))) ||
      (data.fileRef !== undefined &&
        (typeof data.fileRef !== "string" ||
          !/^[a-f0-9]{64}$/.test(data.fileRef) ||
          data.chunks !== undefined)) ||
      (data.type === "blob" && typeof data.mediaType !== "string")
    )
      throw new Error("invalid snapshot binary metadata")
    if (typeof data.fileRef === "string") {
      if (!materialize) return value
      if (!binaryStore?.read) throw new Error("snapshot binary store unavailable")
      const bytes = binaryStore.read(data.fileRef, data.byteLength as number)
      if (bytes.byteLength !== data.byteLength) throw new Error("snapshot binary length mismatch")
      return data.type === "blob"
        ? new Blob([bytes], { type: data.mediaType as string })
        : data.type === "arraybuffer"
          ? new Uint8Array(bytes).buffer
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    const parts: Uint8Array<ArrayBuffer>[] = []
    let remaining = data.byteLength as number
    for (const chunk of data.chunks as unknown[]) {
      const expected = Math.min(BINARY_CHUNK_BYTES, remaining)
      if (
        typeof chunk !== "string" ||
        chunk.length !== Math.ceil(expected / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)
      )
        throw new Error("invalid snapshot binary chunk")
      const bytes = Buffer.from(chunk, "base64")
      if (bytes.length !== expected || bytes.toString("base64") !== chunk)
        throw new Error("invalid snapshot binary length")
      if (materialize) parts.push(new Uint8Array(bytes))
      remaining -= expected
    }
    if (!materialize) return value
    if (data.type === "blob") return new Blob(parts, { type: data.mediaType as string })
    const result = new Uint8Array(data.byteLength as number)
    let offset = 0
    for (const part of parts) {
      result.set(part, offset)
      offset += part.length
    }
    return data.type === "arraybuffer" ? result.buffer : result
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      decodeSnapshotValue(item, materialize, binaryStore),
    ])
  )
}

/** Shared by the legacy snapshot and production per-table storage formats. */
export async function encodeSnapshotRows(
  rows: readonly unknown[],
  binaryStore?: SnapshotBinaryStore
): Promise<unknown[]> {
  const result: unknown[] = []
  for (const row of rows) result.push(await encodeSnapshotValue(row, new Set(), binaryStore))
  return result
}

export function decodeSnapshotRows(value: unknown, binaryStore?: SnapshotBinaryStore): unknown[] {
  if (!Array.isArray(value)) throw new Error("snapshot table is not an array")
  return value.map((item) => decodeSnapshotValue(item, true, binaryStore))
}

/** Resolve file-backed Blobs without materializing their source bytes. Other
 * binary types retain the normal synchronous codec and legacy compatibility. */
export async function decodeSnapshotRowsAsync(
  value: unknown,
  binaryStore: SnapshotBinaryStore
): Promise<unknown[]> {
  if (!Array.isArray(value)) throw new Error("snapshot table is not an array")
  if (!binaryStore.readBlob) return decodeSnapshotRows(value, binaryStore)
  // Validate every envelope before touching any sidecar or stored table.
  for (const row of value) decodeSnapshotValue(row, false)
  const hydrate = async (item: unknown): Promise<unknown> => {
    if (
      !item ||
      typeof item !== "object" ||
      item instanceof Blob ||
      item instanceof Uint8Array ||
      item instanceof ArrayBuffer
    )
      return item
    if (Array.isArray(item)) {
      const entries: unknown[] = []
      for (const entry of item) entries.push(await hydrate(entry))
      return entries
    }
    const object = item as Record<string, unknown>
    const data = object[SNAPSHOT_VALUE_KEY] as Record<string, unknown> | undefined
    if (
      Object.keys(object).length === 1 &&
      data?.type === "blob" &&
      typeof data.fileRef === "string"
    ) {
      const blob = await binaryStore.readBlob!(
        data.fileRef,
        data.byteLength as number,
        data.mediaType as string
      )
      if (!(blob instanceof Blob) || blob.size !== data.byteLength || blob.type !== data.mediaType)
        throw new Error("snapshot binary Blob metadata mismatch")
      return blob
    }
    const entries: [string, unknown][] = []
    for (const [key, child] of Object.entries(object)) entries.push([key, await hydrate(child)])
    return Object.fromEntries(entries)
  }
  return decodeSnapshotRows(await hydrate(value), binaryStore)
}

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
      `Snapshot schema version ${snapshotVersion} is newer than database schema version ${databaseVersion}${
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
    tables[table.name] = await encodeSnapshotRows(await table.toArray())
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
  // A LOWER snapshot version is an ordinary forward move within the storage
  // layout (same rule as `lib/db/storage-layout.ts`): restored rows go through
  // the table middleware, so stamping happens on write. Only a snapshot written
  // by a NEWER build is unsafe, because this build cannot know what changed.
  if (snapshot.version > db.verno) {
    throw new SnapshotVersionMismatchError(snapshot.version, db.verno, databaseName)
  }
  for (const table of db.tables) {
    const rows = snapshot.tables[table.name]
    if (!rows) continue
    const decoded = decodeSnapshotRows(rows)
    await table.clear()
    if (decoded.length > 0) await table.bulkPut(decoded)
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
  try {
    for (const rows of Object.values(tables)) {
      for (const row of rows as unknown[]) decodeSnapshotValue(row, false)
    }
  } catch {
    return { kind: "corrupt", reason: "invalid snapshot binary value" }
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
  try {
    for (const rows of Object.values(tables)) {
      for (const row of rows as unknown[]) decodeSnapshotValue(row, false)
    }
  } catch {
    return null
  }
  return { version: entry.version, tables: tables as Record<string, unknown[]> }
}

export function serializeSnapshot(snapshot: DbSnapshot | MultiDbSnapshot): string {
  return JSON.stringify(snapshot)
}
