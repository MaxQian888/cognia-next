/**
 * CLI-local IndexedDB keystone. The standalone CLI has no browser, so to reuse
 * the desktop's `lib/db/*` Dexie layer (and the headless goal/workflow/team
 * runners that read it) we install `fake-indexeddb` as the process IndexedDB,
 * open the real `CogniaDB`, restore a JSON snapshot from `~/.cognia/db.json`, and
 * persist it back on mutation/exit.
 *
 * Lazy: only the DB-backed feature handlers call `ensureCliDb()` — plain
 * `chat`/`run` never pay the open/seed/restore cost. The serialise/restore logic
 * lives in the pure `./snapshot` module; this file is the (injectable)
 * orchestration.
 */
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { createHash, randomUUID } from "node:crypto"

import { getDb, whenSeeded } from "@/lib/db/schema"
import { createLogger } from "@/packages/logging/src/core"
// Canonical home moved to lib/headless (ADR-0059 T-A1) so the headless brain
// shares the exact shim; re-exported for the existing CLI import sites.
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"

import { resolveHome } from "../config/load"
import { VERSION } from "../version"
import {
  acquireStoreLock,
  readStoreLock,
  releaseStoreLock,
  startStoreLockHeartbeat,
  type StoreLock,
} from "./store-lock"
import {
  decodeSnapshotRowsAsync,
  encodeSnapshotRows,
  parseMultiSnapshot,
  restoreMultiSnapshot,
  serializeSnapshot,
  serializeSources,
  SnapshotVersionMismatchError,
  type DbLike,
  type SnapshotSource,
  type SnapshotBinaryStore,
} from "./snapshot"

export { installFakeIndexedDb }

const log = createLogger("cli.db")

export interface EnsureCliDbOptions {
  /** Config home (`~/.cognia`). */
  home?: string
  /** Snapshot file name within `home`. */
  fileName?: string
  /** Debounced-flush delay (ms). */
  debounceMs?: number
  // ── Injected seams (tests) ──────────────────────────────────────────────────
  installGlobals?: () => void | Promise<void>
  /**
   * Single-database seam. Kept for callers that only care about `CogniaDB`;
   * `getDatabases` wins when both are supplied.
   */
  getDatabase?: () => DbLike
  /**
   * Every database this host persists, in order — the FIRST entry is the
   * primary, i.e. the database a legacy single-database snapshot is restored
   * into. Middleware that must attach before Dexie opens (see
   * `cli/src/serve/durability.ts`) belongs inside this callback.
   */
  getDatabases?: () => readonly SnapshotSource[] | Promise<readonly SnapshotSource[]>
  whenReady?: () => Promise<void>
  readSnapshot?: (path: string) => string | null
  writeSnapshot?: (path: string, data: string) => void
  /** Schedule a deferred flush; returns a cancel fn. Defaults to setTimeout. */
  schedule?: (fn: () => void | Promise<void>, ms: number) => () => void
  /** Re-declare dynamic schemas before a production table snapshot is restored. */
  prepareDynamicSchema?: (
    sources: readonly SnapshotSource[],
    snapshotVersions: Readonly<Record<string, number>>
  ) => Promise<void>
}

export interface CliDbHandle {
  /** Resolves once globals are installed, the db is open + seeded, and any
   * snapshot has been restored. */
  ready: Promise<void>
  /**
   * Whether this process persists the store. `"writer"` holds the
   * `${file}.lock` store lock (or runs an injected-seam store, which has no
   * lock). `"read-only"` is a deliberate dormant mode (Working Rule 7): a
   * follower restores the snapshot and serves reads, but `scheduleFlush`,
   * `scheduleTableFlush` and `flush` are no-ops and it NEVER renames,
   * quarantines, adopts, or deletes a file. Surfaced once via `log.warn`;
   * pinned in `bootstrap.test.ts`.
   */
  readonly mode: "writer" | "read-only"
  /**
   * The store-lock holder when `mode` is `"read-only"` because another live
   * process owns the store; `null` for a writer (or when the holder's lock
   * record could not be parsed).
   */
  readonly heldBy: StoreLock | null
  /** Schedule a debounced persist (call after a mutation). */
  scheduleFlush(): void
  /** Schedule a debounced persist for one mutated database table. */
  scheduleTableFlush(databaseName: string, tableName: string): void
  /** Persist dirty tables now (all tables for the legacy single-file seam). */
  flush(): Promise<void>
  /** Final flush + detach. Safe to call more than once. */
  dispose(): Promise<void>
}

let cached: CliDbHandle | null = null

export class CliDbSnapshotError extends Error {
  readonly snapshotPath: string
  readonly preservedPath: string | null

  constructor(message: string, snapshotPath: string, preservedPath: string | null) {
    super(message)
    this.name = "CliDbSnapshotError"
    this.snapshotPath = snapshotPath
    this.preservedPath = preservedPath
  }
}

function defaultSchedule(fn: () => void | Promise<void>, ms: number): () => void {
  const handle = setTimeout(() => void fn(), ms)
  return () => clearTimeout(handle)
}

function replaceFile(source: string, destination: string): void {
  if (process.platform === "win32") {
    try {
      fs.rmSync(destination, { force: true })
    } catch {
      // A missing destination is fine; rename below remains the source of truth.
    }
  }
  fs.renameSync(source, destination)
}

function writeSyncedFile(file: string, data: string): void {
  const descriptor = fs.openSync(file, "w", 0o600)
  try {
    fs.writeFileSync(descriptor, data, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function syncExistingFile(file: string): void {
  const descriptor = fs.openSync(file, "r")
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function syncParentDirectory(file: string): void {
  if (process.platform === "win32") return
  const descriptor = fs.openSync(path.dirname(file), "r")
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function writeSnapshotAtomically(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const backup = `${file}.bak`
  const backupTemporary = `${backup}.tmp`

  writeSyncedFile(temporary, data)
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backupTemporary)
    fs.chmodSync(backupTemporary, 0o600)
    syncExistingFile(backupTemporary)
    replaceFile(backupTemporary, backup)
  }
  replaceFile(temporary, file)
  fs.chmodSync(file, 0o600)
  syncParentDirectory(file)
}

async function replaceFileAsync(source: string, destination: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.promises.rm(destination, { force: true }).catch(() => {})
  }
  await fs.promises.rename(source, destination)
}

async function syncFileAsync(file: string): Promise<void> {
  const descriptor = await fs.promises.open(file, "r")
  try {
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

/** Same commit order as the synchronous seam, without blocking the serving loop on disk I/O. */
async function writeSnapshotAtomicallyAsync(file: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const backup = `${file}.bak`
  const backupTemporary = `${backup}.tmp`
  const descriptor = await fs.promises.open(temporary, "w", 0o600)
  try {
    await descriptor.writeFile(data, "utf8")
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
  if (fs.existsSync(file)) {
    await fs.promises.copyFile(file, backupTemporary)
    await fs.promises.chmod(backupTemporary, 0o600)
    await syncFileAsync(backupTemporary)
    await replaceFileAsync(backupTemporary, backup)
  }
  await replaceFileAsync(temporary, file)
  await fs.promises.chmod(file, 0o600)
  if (process.platform !== "win32") await syncFileAsync(path.dirname(file))
}

function nextPreservedPath(file: string, label: "corrupt" | "incompatible"): string {
  let generation = 1
  let candidate = `${file}.${label}-${generation}`
  while (fs.existsSync(candidate)) {
    generation++
    candidate = `${file}.${label}-${generation}`
  }
  return candidate
}

function formatStoreLockOwner(heldBy: StoreLock | null): string {
  if (!heldBy) return "another cognia process"
  return `cognia ${heldBy.cliVersion} (pid ${heldBy.pid} on ${heldBy.host}, started ${heldBy.startedAt})`
}

function preserveUnsafeSnapshot(
  file: string,
  label: "corrupt" | "incompatible",
  problem: string,
  readOnlyOwner?: StoreLock | null
): CliDbSnapshotError {
  if (readOnlyOwner !== undefined) {
    // Read-only follower: the file belongs to the lock holder. Refuse without
    // touching it — a follower never renames or quarantines.
    return new CliDbSnapshotError(
      `Database snapshot is ${problem}. The store at ${file} belongs to ${formatStoreLockOwner(readOnlyOwner)}; this process runs read-only, so the snapshot was left untouched.`,
      file,
      null
    )
  }
  const preservedPath = nextPreservedPath(file, label)
  try {
    fs.renameSync(file, preservedPath)
    return new CliDbSnapshotError(
      `Database snapshot is ${problem}. It was preserved at ${preservedPath}; no data was overwritten.`,
      file,
      preservedPath
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return new CliDbSnapshotError(
      `Database snapshot is ${problem}. No data was overwritten, but the snapshot could not be moved aside: ${detail}`,
      file,
      null
    )
  }
}

/** Preserved quarantine generations for `file`, newest first (mtime, then numeric suffix). */
function preservedSnapshotGenerations(file: string): string[] {
  if (fs.existsSync(file) || !fs.existsSync(path.dirname(file))) return []
  const name = path.basename(file)
  const directory = path.dirname(file)
  return fs
    .readdirSync(directory)
    .filter((entry) =>
      ["corrupt", "incompatible"].some((label) => {
        const prefix = `${name}.${label}-`
        return entry.startsWith(prefix) && /^[1-9]\d*$/.test(entry.slice(prefix.length))
      })
    )
    .sort(
      (a, b) =>
        fs.statSync(path.join(directory, b)).mtimeMs -
          fs.statSync(path.join(directory, a)).mtimeMs ||
        b.localeCompare(a, undefined, { numeric: true })
    )
    .map((entry) => path.join(directory, entry))
}

function assertNoPendingSnapshotRecovery(file: string): void {
  const preservedPath = preservedSnapshotGenerations(file)[0]
  if (!preservedPath) return
  throw new CliDbSnapshotError(
    `Database snapshot requires recovery. A snapshot was preserved at ${preservedPath}; restore a compatible snapshot at ${file} before restarting. No data was overwritten.`,
    file,
    preservedPath
  )
}

interface TableStoreWriter {
  pid: number
  host: string
  cliVersion: string
  writtenAt: number
}

interface TableStoreManifest {
  snapshotFormat: 3
  dbs: Record<string, { version: number; tables: string[] }>
  /** Diagnostics about the process that last flushed. Never load-bearing. */
  writer?: TableStoreWriter
}

/** Human-readable writer provenance for error messages; empty when absent. */
function describeWriter(writer: TableStoreWriter | undefined): string {
  if (!writer) return ""
  return `; written by cognia ${writer.cliVersion} pid ${writer.pid} on ${writer.host} at ${new Date(writer.writtenAt).toISOString()}`
}

function tableKey(databaseName: string, tableName: string): string {
  return `${databaseName}\0${tableName}`
}

function splitTableKey(key: string): [databaseName: string, tableName: string] {
  const separator = key.indexOf("\0")
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function tableFileName(databaseName: string, tableName: string): string {
  return `${encodeURIComponent(databaseName)}--${encodeURIComponent(tableName)}.json`
}

/** Binary originals do not belong in a JSON string: a supported 500 MiB source
 * exceeds V8's string limit after base64. Sidecars commit before their row refs. */
function tableBinaryStore(tableDirectory: string): SnapshotBinaryStore {
  const directory = path.join(tableDirectory, "binary")
  const readBlob = async (
    reference: string,
    byteLength: number,
    mediaType: string
  ): Promise<Blob> => {
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("invalid binary source reference")
    const blob = await fs.openAsBlob(path.join(directory, reference), { type: mediaType })
    if (blob.size !== byteLength) throw new Error("snapshot binary length mismatch")
    const hash = createHash("sha256")
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()))
    }
    if (hash.digest("hex") !== reference) throw new Error("snapshot binary content mismatch")
    // Node's direct file-backed Blob rejects structuredClone, which IndexedDB
    // requires. A native composite Blob shares the backing data lazily while
    // remaining cloneable; do not turn the source into an ArrayBuffer here.
    return new Blob([blob], { type: mediaType })
  }
  return {
    readBlob,
    write: async (value) => {
      await fs.promises.mkdir(directory, { recursive: true })
      const temporary = path.join(directory, `.tmp-${randomUUID()}`)
      const descriptor = await fs.promises.open(temporary, "wx", 0o600)
      const hash = createHash("sha256")
      const size = value instanceof Blob ? value.size : value.byteLength
      try {
        try {
          for (let offset = 0; offset < size; offset += 1024 * 1024) {
            const bytes =
              value instanceof Blob
                ? new Uint8Array(await value.slice(offset, offset + 1024 * 1024).arrayBuffer())
                : value instanceof Uint8Array
                  ? value.subarray(offset, offset + 1024 * 1024)
                  : new Uint8Array(value, offset, Math.min(1024 * 1024, size - offset))
            hash.update(bytes)
            await descriptor.writeFile(bytes)
          }
          await descriptor.sync()
        } finally {
          await descriptor.close()
        }
        const reference = hash.digest("hex")
        const destination = path.join(directory, reference)
        if (fs.existsSync(destination)) {
          // A restored Blob is backed by this immutable file. Replacing it,
          // even with identical bytes, invalidates Node's lazy Blob handles.
          await readBlob(reference, size, "")
        } else {
          await replaceFileAsync(temporary, destination)
        }
        if (process.platform !== "win32") await syncFileAsync(directory)
        return reference
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {})
      }
    },
    read: (reference, byteLength) => {
      if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("invalid binary source reference")
      const file = path.join(directory, reference)
      if (fs.statSync(file).size !== byteLength) throw new Error("snapshot binary length mismatch")
      const bytes = fs.readFileSync(file)
      if (createHash("sha256").update(bytes).digest("hex") !== reference)
        throw new Error("snapshot binary content mismatch")
      return bytes
    },
  }
}

/** Keep both current and recovery-table generations; a failed flush cannot
 * collect source bytes that its last durable table or backup still references. */
async function collectTableBinaryOrphans(tableDirectory: string): Promise<void> {
  const directory = path.join(tableDirectory, "binary")
  if (!fs.existsSync(directory)) return
  const references = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const object = value as Record<string, unknown>
    const envelope = object.$cogniaSnapshotValue as { fileRef?: unknown } | undefined
    if (envelope && typeof envelope.fileRef === "string") references.add(envelope.fileRef)
    for (const item of Object.values(object)) visit(item)
  }
  try {
    for (const file of await fs.promises.readdir(tableDirectory)) {
      if (file.endsWith(".json") || file.endsWith(".json.bak"))
        visit(JSON.parse(await fs.promises.readFile(path.join(tableDirectory, file), "utf8")))
    }
  } catch {
    return
  }
  for (const file of await fs.promises.readdir(directory)) {
    if (/^[a-f0-9]{64}$/.test(file) && !references.has(file))
      await fs.promises.rm(path.join(directory, file), { force: true })
  }
}

function includedTableNames(source: SnapshotSource): string[] {
  const excluded = new Set(source.excludeTables ?? [])
  return source.db.tables.filter((table) => !excluded.has(table.name)).map((table) => table.name)
}

function markAllTablesDirty(sources: readonly SnapshotSource[], dirtyTables: Set<string>): void {
  for (const source of sources) {
    for (const tableName of includedTableNames(source)) {
      dirtyTables.add(tableKey(source.name, tableName))
    }
  }
}

function parseTableStoreManifest(text: string): TableStoreManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const root = parsed as Record<string, unknown>
  if (root.snapshotFormat !== 3 || !root.dbs || typeof root.dbs !== "object") return null
  const dbs: TableStoreManifest["dbs"] = {}
  for (const [databaseName, raw] of Object.entries(root.dbs as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const entry = raw as Record<string, unknown>
    if (
      typeof entry.version !== "number" ||
      !Number.isFinite(entry.version) ||
      !Array.isArray(entry.tables) ||
      entry.tables.some((table) => typeof table !== "string")
    ) {
      return null
    }
    dbs[databaseName] = {
      version: entry.version,
      tables: [...(entry.tables as string[])],
    }
  }
  // `writer` is diagnostics, not data: a malformed record is dropped, never a
  // reason to refuse the store.
  let writer: TableStoreWriter | undefined
  if (root.writer && typeof root.writer === "object" && !Array.isArray(root.writer)) {
    const candidate = root.writer as Record<string, unknown>
    if (
      typeof candidate.pid === "number" &&
      typeof candidate.host === "string" &&
      typeof candidate.cliVersion === "string" &&
      typeof candidate.writtenAt === "number"
    ) {
      writer = {
        pid: candidate.pid,
        host: candidate.host,
        cliVersion: candidate.cliVersion,
        writtenAt: candidate.writtenAt,
      }
    }
  }
  return { snapshotFormat: 3, dbs, writer }
}

interface TableStoreRestore {
  /** Tables whose snapshot rows were overlaid onto the live database. */
  restored: Set<string>
  /**
   * Every included table of a source whose snapshot sat at a LOWER schema
   * version — an ordinary forward move. The next flush must rewrite these
   * table files and the manifest at the live version so the on-disk store
   * converges instead of being re-adopted on every boot.
   */
  forwardMoved: Set<string>
}

async function restoreTableStore(
  sources: readonly SnapshotSource[],
  manifestFile: string,
  tableDirectory: string,
  preserve: (label: "corrupt" | "incompatible", problem: string) => CliDbSnapshotError = (
    label,
    problem
  ) => preserveUnsafeSnapshot(manifestFile, label, problem)
): Promise<TableStoreRestore> {
  const rawManifest = fs.readFileSync(manifestFile, "utf8")
  const manifest = parseTableStoreManifest(rawManifest)
  if (!manifest) {
    throw preserve("corrupt", "corrupt (invalid table manifest)")
  }
  const restored = new Set<string>()
  const forwardMoved = new Set<string>()
  for (const source of sources) {
    const entry = manifest.dbs[source.name]
    if (!entry) continue
    // Same rule as `lib/db/storage-layout.ts`: a LOWER snapshot version is an
    // ordinary forward move — restored rows go back through the table
    // middleware, so stamping happens. Only a snapshot written by a NEWER
    // build is unsafe to open.
    if (entry.version > source.db.verno) {
      throw preserve(
        "incompatible",
        `incompatible: snapshot schema version ${entry.version} is newer than database schema version ${source.db.verno} for database ${source.name}; it was written by a newer build${describeWriter(manifest.writer)}`
      )
    }
    const tablesByName = new Map(source.db.tables.map((table) => [table.name, table]))
    for (const tableName of entry.tables) {
      const table = tablesByName.get(tableName)
      if (!table) continue
      const tableFile = path.join(tableDirectory, tableFileName(source.name, tableName))
      let rows: unknown
      try {
        rows = await decodeSnapshotRowsAsync(
          JSON.parse(fs.readFileSync(tableFile, "utf8")),
          tableBinaryStore(tableDirectory)
        )
      } catch {
        throw preserve(
          "corrupt",
          `corrupt (missing or invalid table file for ${source.name}.${tableName})`
        )
      }
      if (!Array.isArray(rows)) {
        throw preserve(
          "corrupt",
          `corrupt (table file for ${source.name}.${tableName} is not an array)`
        )
      }
      await table.clear()
      if (rows.length > 0) await table.bulkPut(rows)
      restored.add(tableKey(source.name, tableName))
    }
    if (entry.version < source.db.verno) {
      for (const tableName of includedTableNames(source)) {
        forwardMoved.add(tableKey(source.name, tableName))
      }
    }
  }
  return { restored, forwardMoved }
}

async function flushDirtyTables(
  sources: readonly SnapshotSource[],
  dirtyKeys: readonly string[],
  tableDirectory: string,
  manifestFile: string
): Promise<void> {
  const sourceByName = new Map(sources.map((source) => [source.name, source]))
  for (const key of dirtyKeys) {
    const [databaseName, tableName] = splitTableKey(key)
    const source = sourceByName.get(databaseName)
    const table = source?.db.tables.find((candidate) => candidate.name === tableName)
    if (!source || !table || source.excludeTables?.includes(tableName)) continue
    const rows = await table.toArray()
    await writeSnapshotAtomicallyAsync(
      path.join(tableDirectory, tableFileName(databaseName, tableName)),
      JSON.stringify(await encodeSnapshotRows(rows, tableBinaryStore(tableDirectory)))
    )
  }

  const dbs: TableStoreManifest["dbs"] = {}
  for (const source of sources) {
    dbs[source.name] = {
      version: source.db.verno,
      // Dynamic plugin schemas can be registered while a long flush is still
      // writing its original dirty-key snapshot. Only publish tables whose
      // files are already durable; a later table mutation/flush adds the new
      // table after its own file has been written.
      tables: includedTableNames(source).filter((tableName) =>
        fs.existsSync(path.join(tableDirectory, tableFileName(source.name, tableName)))
      ),
    }
  }
  await writeSnapshotAtomicallyAsync(
    manifestFile,
    JSON.stringify({
      snapshotFormat: 3,
      dbs,
      writer: {
        pid: process.pid,
        host: os.hostname(),
        cliVersion: VERSION,
        writtenAt: Date.now(),
      },
    } satisfies TableStoreManifest)
  )
  await collectTableBinaryOrphans(tableDirectory)
}

/**
 * Normalise the database seams into one source factory.
 *
 * Default: `CogniaDB`, whose Dexie name is per-account and so is read off the
 * instance rather than hardcoded. The scheduler used to contribute a second
 * source (`CogniaSchedulerDB`); schema v219 folded it into the account
 * database, so what survives is its table exclusion. The scheduler module is
 * imported lazily so `chat` and `run`, which never open a database, keep paying
 * nothing for it.
 */
function resolveSourcesFactory(opts: EnsureCliDbOptions): () => Promise<readonly SnapshotSource[]> {
  if (opts.getDatabases) return async () => opts.getDatabases!()
  if (opts.getDatabase) {
    return async () => {
      const db = opts.getDatabase!()
      return [{ name: db.name ?? "CogniaDB", db }]
    }
  }
  return async () => {
    const { SCHEDULER_SNAPSHOT_EXCLUDED_TABLES } = await import("@/lib/scheduler/scheduler-db")
    const primary = getDb() as unknown as DbLike
    return [
      {
        name: primary.name ?? "CogniaDB",
        db: primary,
        excludeTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
      },
    ]
  }
}

async function prepareBuiltinPluginSchema(
  sources: readonly SnapshotSource[],
  snapshotVersions: Readonly<Record<string, number>>
): Promise<void> {
  const primary = sources[0]
  const snapshotVersion = snapshotVersions[primary?.name ?? ""] ?? primary?.db.verno ?? 0
  if (!primary || snapshotVersion <= primary.db.verno) return

  const [{ getBrowserBuiltinRegistry }, { restorePluginTables }] = await Promise.all([
    import("@/lib/plugin/core/browser-builtin-registry"),
    import("@/lib/plugin/dexie/bridge"),
  ])
  const manifestDexie = new Map(
    getBrowserBuiltinRegistry()
      .map((entry) => [entry.manifest.id, entry.manifest.dexie] as const)
      .filter(
        (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== undefined
      )
  )
  if (manifestDexie.size === 0) return
  // `minimumVersion` is what makes the restore land on the SAME number the
  // snapshot was written at. Runtime registration bumps once per table-owning
  // plugin, while this consolidated re-declaration bumps once in total, so
  // without the floor the database opens one or more versions below its own
  // snapshot and `restoreTableStore` rejects it as incompatible. On the
  // headless brain that rejection is silent data loss: the manifest is moved
  // aside and the supervisor reboots the brain on an empty database.
  await restorePluginTables(() => primary.db as unknown as import("dexie").default, manifestDexie, {
    registerMissing: true,
    minimumVersion: snapshotVersion,
  })
}

function create(opts: EnsureCliDbOptions): CliDbHandle {
  const home = opts.home ?? resolveHome(process.env, os.homedir())
  const file = path.join(home, opts.fileName ?? "db.json")
  const debounceMs = opts.debounceMs ?? 400
  const installGlobals = opts.installGlobals ?? (() => installFakeIndexedDb())
  const getDatabases = resolveSourcesFactory(opts)
  const waitReady = opts.whenReady ?? whenSeeded
  const read = opts.readSnapshot ?? ((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null))
  const write = opts.writeSnapshot ?? writeSnapshotAtomically
  const schedule = opts.schedule ?? defaultSchedule
  const prepareDynamicSchema = opts.prepareDynamicSchema ?? prepareBuiltinPluginSchema
  // Production uses format v3: one file per database table. Injected snapshot
  // seams retain the format-v2 envelope so focused unit tests and embedders can
  // keep treating persistence as one opaque read/write operation.
  const useTableStore = opts.readSnapshot === undefined && opts.writeSnapshot === undefined
  const tableDirectory = `${file}.tables`
  const manifestFile = path.join(tableDirectory, "manifest.json")

  // ── Single-writer store lock (production table store only) ────────────────
  // Injected-seam stores keep their historical lock-free behaviour. A process
  // that loses the race runs read-only: it restores the snapshot for reads but
  // never mutates a file, so two concurrently running builds cannot fight over
  // the manifest.
  let mode: "writer" | "read-only" = "writer"
  let heldBy: StoreLock | null = null
  let storeLock: StoreLock | null = null
  let stopLockHeartbeat: (() => void) | null = null
  let lockLost = false
  let readOnlyWarned = false

  function releaseStoreLockIfHeld(): void {
    stopLockHeartbeat?.()
    stopLockHeartbeat = null
    if (storeLock) {
      releaseStoreLock(storeLock, file)
      storeLock = null
    }
  }

  if (useTableStore) {
    const acquisition = acquireStoreLock(file)
    if (acquisition.ok) {
      storeLock = acquisition.lock
      stopLockHeartbeat = startStoreLockHeartbeat(storeLock, file, {}, () => {
        if (mode !== "writer") return
        mode = "read-only"
        lockLost = true
        heldBy = readStoreLock(file)
        // Never fight another writer: the rest of this handle's life is
        // read-only, and this is the single surfaced notice.
        log.error(
          `Lost the database store lock at ${file}; this process switches to read-only and will not persist further database changes.`
        )
      })
    } else {
      mode = "read-only"
      heldBy = acquisition.heldBy
    }
  }

  function warnReadOnly(): void {
    if (readOnlyWarned) return
    readOnlyWarned = true
    log.warn(
      `${formatStoreLockOwner(heldBy)} owns ${file}; this process runs read-only and will not persist database changes. Set COGNIA_HOME to use a separate store.`
    )
  }

  let sources: readonly SnapshotSource[] = []
  let cancelTimer: (() => void) | null = null
  let disposed = false
  const dirtyTables = new Set<string>()
  let flushTail: Promise<void> = Promise.resolve()

  function preserve(fileToPreserve: string) {
    return (label: "corrupt" | "incompatible", problem: string) =>
      preserveUnsafeSnapshot(
        fileToPreserve,
        label,
        problem,
        mode === "read-only" ? heldBy : undefined
      )
  }

  const ready = (async () => {
    if (useTableStore && mode === "read-only") {
      // A follower never mutates the store, so there is no adoption to try:
      // pending recovery still refuses the boot, exactly as it does for a
      // writer, but nothing is renamed or deleted here.
      assertNoPendingSnapshotRecovery(manifestFile)
      if (!fs.existsSync(manifestFile)) assertNoPendingSnapshotRecovery(file)
    } else if (!useTableStore) {
      assertNoPendingSnapshotRecovery(file)
    }
    await installGlobals()
    sources = await getDatabases()
    await waitReady()
    // `whenSeeded` only covers the primary database. Open the rest explicitly so
    // their `tables` are live before restore/serialize touch them, and so an
    // open failure surfaces here rather than inside the first debounced flush.
    for (const source of sources) await source.db.open?.()

    let dynamicSchemaPrepared = false
    const prepareForManifest = async (manifest: TableStoreManifest) => {
      if (dynamicSchemaPrepared) return
      await prepareDynamicSchema(
        sources,
        Object.fromEntries(
          Object.entries(manifest.dbs).map(([name, entry]) => [name, entry.version])
        )
      )
      dynamicSchemaPrepared = true
    }

    if (useTableStore && mode === "writer" && !fs.existsSync(manifestFile)) {
      // The canonical manifest is gone but a quarantine generation remains.
      // Before refusing forever, try to adopt the NEWEST generation — the
      // only one that can be coherent with the shared table files.
      const candidatePath = preservedSnapshotGenerations(manifestFile)[0]
      if (candidatePath) {
        const candidateText = fs.readFileSync(candidatePath, "utf8")
        const candidate = parseTableStoreManifest(candidateText)
        const writerSuffix = describeWriter(candidate?.writer)
        const refuse = (reason: string): never => {
          throw new CliDbSnapshotError(
            `Database snapshot requires recovery. The newest preserved snapshot at ${candidatePath} ${reason}${writerSuffix}. Restore a compatible snapshot at ${manifestFile} before restarting. No data was overwritten.`,
            manifestFile,
            candidatePath
          )
        }
        if (!candidate) {
          refuse("is not a valid table manifest")
        } else {
          await prepareForManifest(candidate)
          const tablesBySource = new Map(
            sources.map(
              (source) =>
                [source.name, new Set(source.db.tables.map((table) => table.name))] as const
            )
          )
          for (const source of sources) {
            const entry = candidate.dbs[source.name]
            if (!entry) continue
            if (entry.version > source.db.verno) {
              refuse(
                `was written by a newer build (schema ${entry.version} > ${source.db.verno} for database ${source.name})`
              )
            }
            const schemaTables = tablesBySource.get(source.name) ?? new Set<string>()
            for (const tableName of entry.tables) {
              if (!schemaTables.has(tableName)) continue
              const tableFile = path.join(tableDirectory, tableFileName(source.name, tableName))
              let readable = false
              try {
                readable = Array.isArray(JSON.parse(fs.readFileSync(tableFile, "utf8")))
              } catch {
                readable = false
              }
              if (!readable) {
                refuse(`is missing a readable table file for ${source.name}.${tableName}`)
              }
            }
          }
          writeSnapshotAtomically(manifestFile, candidateText)
          const primaryVersion = candidate.dbs[sources[0]?.name ?? ""]?.version
          log.warn(
            `Recovered database snapshot manifest from ${candidatePath} (schema ${primaryVersion ?? "?"} → ${sources[0]?.db.verno ?? "?"}).`
          )
          // It is the canonical manifest now; older generations are left alone.
          fs.rmSync(candidatePath, { force: true })
        }
      }
      if (!fs.existsSync(manifestFile)) {
        // No usable generation: keep the legacy-file pending check, which a
        // table-store manifest would have suppressed had one existed.
        assertNoPendingSnapshotRecovery(file)
      }
    }

    let restore: TableStoreRestore | null = null
    if (useTableStore && fs.existsSync(manifestFile)) {
      const manifest = parseTableStoreManifest(fs.readFileSync(manifestFile, "utf8"))
      if (manifest) await prepareForManifest(manifest)
      restore = await restoreTableStore(
        sources,
        manifestFile,
        tableDirectory,
        preserve(manifestFile)
      )
    }
    if (!restore) {
      const parsed = parseMultiSnapshot(read(file), sources[0]?.name ?? "CogniaDB")
      if (parsed.kind === "corrupt") {
        throw preserve(file)("corrupt", `corrupt (${parsed.reason})`)
      }
      if (parsed.kind === "valid") {
        try {
          await restoreMultiSnapshot(sources, parsed.snapshot)
        } catch (error) {
          if (error instanceof SnapshotVersionMismatchError) {
            throw preserve(file)(
              "incompatible",
              `incompatible: snapshot schema version ${error.snapshotVersion} is newer than database schema version ${error.databaseVersion}` +
                (error.databaseName ? ` for database ${error.databaseName}` : "") +
                "; it was written by a newer build"
            )
          }
          throw error
        }
      }
    }
    if (useTableStore) {
      for (const source of sources) {
        for (const tableName of includedTableNames(source)) {
          const key = tableKey(source.name, tableName)
          if (!restore?.restored.has(key)) dirtyTables.add(key)
        }
      }
      for (const key of restore?.forwardMoved ?? []) dirtyTables.add(key)
    }
  })()

  // A boot that fails must not keep the store lock: the next process (or the
  // repaired retry) would otherwise follow forever behind a dead writer.
  void ready.catch(() => releaseStoreLockIfHeld())

  async function flushOnce(): Promise<void> {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    await ready
    if (useTableStore && mode !== "writer") {
      if (!lockLost) warnReadOnly()
      return
    }
    if (!useTableStore) {
      const snapshot = await serializeSources(sources)
      write(file, serializeSnapshot(snapshot))
      return
    }
    if (dirtyTables.size === 0) return
    const flushing = [...dirtyTables]
    for (const key of flushing) dirtyTables.delete(key)
    try {
      await flushDirtyTables(sources, flushing, tableDirectory, manifestFile)
    } catch (error) {
      // A failed write persisted an unknown prefix. Keep every intended table
      // dirty so the next flush repairs the set; concurrent mutations have
      // already re-added their keys and remain present.
      for (const key of flushing) dirtyTables.add(key)
      throw error
    }
  }

  function flush(): Promise<void> {
    const next = flushTail.then(flushOnce, flushOnce)
    flushTail = next.catch(() => {})
    return next
  }

  function scheduleFlush(): void {
    if (useTableStore && mode !== "writer") {
      if (!lockLost) warnReadOnly()
      return
    }
    if (useTableStore) markAllTablesDirty(sources, dirtyTables)
    scheduleDebouncedFlush()
  }

  function scheduleTableFlush(databaseName: string, tableName: string): void {
    if (useTableStore && mode !== "writer") {
      if (!lockLost) warnReadOnly()
      return
    }
    if (!useTableStore) {
      scheduleDebouncedFlush()
      return
    }
    const source = sources.find((candidate) => candidate.name === databaseName)
    if (!source || source.excludeTables?.includes(tableName)) return
    if (!source.db.tables.some((table) => table.name === tableName)) return
    dirtyTables.add(tableKey(databaseName, tableName))
    scheduleDebouncedFlush()
  }

  function scheduleDebouncedFlush(): void {
    if (cancelTimer) cancelTimer()
    cancelTimer = schedule(async () => {
      cancelTimer = null
      try {
        await flush()
      } catch (error) {
        log.error("Background database flush failed; pending changes remain in memory.", error, {
          file,
        })
      }
    }, debounceMs)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    await flush()
    disposed = true
    // Final flush has settled; release the store lock so a later process can
    // take over as writer.
    releaseStoreLockIfHeld()
  }

  return {
    ready,
    get mode() {
      return mode
    },
    get heldBy() {
      return heldBy
    },
    scheduleFlush,
    scheduleTableFlush,
    flush,
    dispose,
  }
}

/**
 * Open (or return the already-open) CLI-local database. Idempotent — the first
 * call installs globals + restores the snapshot; later calls return the cached
 * handle. `dispose()` clears the cache for a clean reopen.
 */
export async function ensureCliDb(opts: EnsureCliDbOptions = {}): Promise<CliDbHandle> {
  if (cached) {
    const pending = cached
    await pending.ready
    return pending
  }
  const handle = create(opts)
  const wrapped: CliDbHandle = {
    ready: handle.ready,
    get mode() {
      return handle.mode
    },
    get heldBy() {
      return handle.heldBy
    },
    scheduleFlush: () => handle.scheduleFlush(),
    scheduleTableFlush: (databaseName, tableName) =>
      handle.scheduleTableFlush(databaseName, tableName),
    flush: () => handle.flush(),
    dispose: async () => {
      await handle.dispose()
      if (cached === wrapped) cached = null
    },
  }
  cached = wrapped
  try {
    await wrapped.ready
    return wrapped
  } catch (error) {
    if (cached === wrapped) cached = null
    throw error
  }
}

/** Test-only: drop the cached handle. */
export function __resetCliDbForTesting(): void {
  cached = null
}
