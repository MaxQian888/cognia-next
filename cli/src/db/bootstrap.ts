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
}

export interface CliDbHandle {
  /** Resolves once globals are installed, the db is open + seeded, and any
   * snapshot has been restored. */
  ready: Promise<void>
  /** Schedule a debounced persist (call after a mutation). */
  scheduleFlush(): void
  /** Persist the whole db to the snapshot file now. */
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

/**
 * Normalise the two database seams into one source factory.
 *
 * Default: `CogniaDB` (whose Dexie name is per-account, so it is read off the
 * instance rather than hardcoded) plus the scheduler's separate
 * `CogniaSchedulerDB`, minus the tables that database excludes on purpose.
 * The scheduler module is imported lazily so `chat`/`run` — which never open a
 * database — keep paying nothing for it.
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
    const [{ schedulerDb, SCHEDULER_DB_NAME, SCHEDULER_SNAPSHOT_EXCLUDED_TABLES }] =
      await Promise.all([import("@/lib/scheduler/scheduler-db")])
    const primary = getDb() as unknown as DbLike
    return [
      { name: primary.name ?? "CogniaDB", db: primary },
      {
        name: SCHEDULER_DB_NAME,
        db: schedulerDb as unknown as DbLike,
        excludeTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
      },
    ]
  }
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

  let sources: readonly SnapshotSource[] = []
  let cancelTimer: (() => void) | null = null
  let disposed = false

  const ready = (async () => {
    await installGlobals()
    sources = await getDatabases()
    await waitReady()
    // `whenSeeded` only covers the primary database. Open the rest explicitly so
    // their `tables` are live before restore/serialize touch them, and so an
    // open failure surfaces here rather than inside the first debounced flush.
    for (const source of sources) await source.db.open?.()
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
  })()

  async function flush(): Promise<void> {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    await ready
    const snapshot = await serializeSources(sources)
    write(file, serializeSnapshot(snapshot))
  }

  function scheduleFlush(): void {
    if (cancelTimer) cancelTimer()
    cancelTimer = schedule(async () => {
      cancelTimer = null
      await flush()
    }, debounceMs)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    await flush()
  }

  return { ready, scheduleFlush, flush, dispose }
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
