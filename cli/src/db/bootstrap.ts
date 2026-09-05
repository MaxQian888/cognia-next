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

import { getDb, whenSeeded } from "@/lib/db/schema"
import { createLogger } from "@/packages/logging/src/core"
// Canonical home moved to lib/headless (ADR-0059 T-A1) so the headless brain
// shares the exact shim; re-exported for the existing CLI import sites.
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"

import { resolveHome } from "../config/load"
import {
  parseMultiSnapshot,
  restoreMultiSnapshot,
  serializeSnapshot,
  serializeSources,
  SnapshotVersionMismatchError,
  type DbLike,
  type SnapshotSource,
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

function nextPreservedPath(file: string, label: "corrupt" | "incompatible"): string {
  let generation = 1
  let candidate = `${file}.${label}-${generation}`
  while (fs.existsSync(candidate)) {
    generation++
    candidate = `${file}.${label}-${generation}`
  }
  return candidate
}

function preserveUnsafeSnapshot(
  file: string,
  label: "corrupt" | "incompatible",
  problem: string
): CliDbSnapshotError {
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

interface TableStoreManifest {
  snapshotFormat: 3
  dbs: Record<string, { version: number; tables: string[] }>
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
  return { snapshotFormat: 3, dbs }
}

async function restoreTableStore(
  sources: readonly SnapshotSource[],
  manifestFile: string,
  tableDirectory: string
): Promise<Set<string>> {
  const rawManifest = fs.readFileSync(manifestFile, "utf8")
  const manifest = parseTableStoreManifest(rawManifest)
  if (!manifest) {
    throw preserveUnsafeSnapshot(manifestFile, "corrupt", "corrupt (invalid table manifest)")
  }
  const restored = new Set<string>()
  for (const source of sources) {
    const entry = manifest.dbs[source.name]
    if (!entry) continue
    if (entry.version !== source.db.verno) {
      throw preserveUnsafeSnapshot(
        manifestFile,
        "incompatible",
        `incompatible: snapshot schema version ${entry.version} does not match database schema version ${source.db.verno} for database ${source.name}`
      )
    }
    const tablesByName = new Map(source.db.tables.map((table) => [table.name, table]))
    for (const tableName of entry.tables) {
      const table = tablesByName.get(tableName)
      if (!table) continue
      const tableFile = path.join(tableDirectory, tableFileName(source.name, tableName))
      let rows: unknown
      try {
        rows = JSON.parse(fs.readFileSync(tableFile, "utf8"))
      } catch {
        throw preserveUnsafeSnapshot(
          manifestFile,
          "corrupt",
          `corrupt (missing or invalid table file for ${source.name}.${tableName})`
        )
      }
      if (!Array.isArray(rows)) {
        throw preserveUnsafeSnapshot(
          manifestFile,
          "corrupt",
          `corrupt (table file for ${source.name}.${tableName} is not an array)`
        )
      }
      await table.clear()
      if (rows.length > 0) await table.bulkPut(rows)
      restored.add(tableKey(source.name, tableName))
    }
  }
  return restored
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
    writeSnapshotAtomically(
      path.join(tableDirectory, tableFileName(databaseName, tableName)),
      JSON.stringify(rows)
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
  writeSnapshotAtomically(
    manifestFile,
    JSON.stringify({ snapshotFormat: 3, dbs } satisfies TableStoreManifest)
  )
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
  if (!primary || (snapshotVersions[primary.name] ?? primary.db.verno) <= primary.db.verno) return

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
  await restorePluginTables(() => primary.db as unknown as import("dexie").default, manifestDexie, {
    registerMissing: true,
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

  let sources: readonly SnapshotSource[] = []
  let cancelTimer: (() => void) | null = null
  let disposed = false
  const dirtyTables = new Set<string>()
  let flushTail: Promise<void> = Promise.resolve()

  const ready = (async () => {
    await installGlobals()
    sources = await getDatabases()
    await waitReady()
    // `whenSeeded` only covers the primary database. Open the rest explicitly so
    // their `tables` are live before restore/serialize touch them, and so an
    // open failure surfaces here rather than inside the first debounced flush.
    for (const source of sources) await source.db.open?.()
    if (useTableStore && fs.existsSync(manifestFile)) {
      const manifest = parseTableStoreManifest(fs.readFileSync(manifestFile, "utf8"))
      if (manifest) {
        await prepareDynamicSchema(
          sources,
          Object.fromEntries(
            Object.entries(manifest.dbs).map(([name, entry]) => [name, entry.version])
          )
        )
      }
    }
    const restoredTableKeys =
      useTableStore && fs.existsSync(manifestFile)
        ? await restoreTableStore(sources, manifestFile, tableDirectory)
        : null
    if (!restoredTableKeys) {
      const parsed = parseMultiSnapshot(read(file), sources[0]?.name ?? "CogniaDB")
      if (parsed.kind === "corrupt") {
        throw preserveUnsafeSnapshot(file, "corrupt", `corrupt (${parsed.reason})`)
      }
      if (parsed.kind === "valid") {
        try {
          await restoreMultiSnapshot(sources, parsed.snapshot)
        } catch (error) {
          if (error instanceof SnapshotVersionMismatchError) {
            throw preserveUnsafeSnapshot(
              file,
              "incompatible",
              `incompatible: snapshot schema version ${error.snapshotVersion} does not match database schema version ${error.databaseVersion}` +
                (error.databaseName ? ` for database ${error.databaseName}` : "")
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
          if (!restoredTableKeys?.has(key)) dirtyTables.add(key)
        }
      }
    }
  })()

  async function flushOnce(): Promise<void> {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    await ready
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
    if (useTableStore) markAllTablesDirty(sources, dirtyTables)
    scheduleDebouncedFlush()
  }

  function scheduleTableFlush(databaseName: string, tableName: string): void {
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
  }

  return { ready, scheduleFlush, scheduleTableFlush, flush, dispose }
}

/**
 * Open (or return the already-open) CLI-local database. Idempotent — the first
 * call installs globals + restores the snapshot; later calls return the cached
 * handle. `dispose()` clears the cache for a clean reopen.
 */
export async function ensureCliDb(opts: EnsureCliDbOptions = {}): Promise<CliDbHandle> {
  if (cached) return cached
  const handle = create(opts)
  const wrapped: CliDbHandle = {
    ...handle,
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
