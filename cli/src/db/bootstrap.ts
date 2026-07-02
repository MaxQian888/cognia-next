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
  parseSnapshot,
  restoreSnapshot,
  serializeDb,
  serializeSnapshot,
  type DbLike,
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
  getDatabase?: () => DbLike
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

function defaultSchedule(fn: () => void | Promise<void>, ms: number): () => void {
  const handle = setTimeout(() => void fn(), ms)
  return () => clearTimeout(handle)
}

function create(opts: EnsureCliDbOptions): CliDbHandle {
  const home = opts.home ?? resolveHome(process.env, os.homedir())
  const file = path.join(home, opts.fileName ?? "db.json")
  const debounceMs = opts.debounceMs ?? 400
  const installGlobals = opts.installGlobals ?? (() => installFakeIndexedDb())
  const getDatabase = opts.getDatabase ?? (() => getDb() as unknown as DbLike)
  const waitReady = opts.whenReady ?? whenSeeded
  const read = opts.readSnapshot ?? ((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null))
  const write =
    opts.writeSnapshot ??
    ((p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, data, { mode: 0o600 })
    })
  const schedule = opts.schedule ?? defaultSchedule

  let db: DbLike
  let cancelTimer: (() => void) | null = null
  let disposed = false

  const ready = (async () => {
    await installGlobals()
    db = getDatabase()
    await waitReady()
    const snapshot = parseSnapshot(read(file))
    if (snapshot) await restoreSnapshot(db, snapshot)
  })()

  async function flush(): Promise<void> {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
    await ready
    const snapshot = await serializeDb(db)
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
  await wrapped.ready
  return wrapped
}

/** Test-only: drop the cached handle. */
export function __resetCliDbForTesting(): void {
  cached = null
}
