/**
 * Brain durability v1 (ADR-0059 T-B3, risk ladder v1).
 *
 * fake-indexeddb is in-memory; persistence is the JSON snapshot from
 * `cli/src/db/bootstrap.ts` (`ensureCliDb`). This module hardens it for a
 * long-lived serve process:
 *
 * - **Write-triggered flush**: a Dexie DBCore middleware schedules the
 *   debounced snapshot after EVERY mutation — closing the gap where only
 *   call sites that remembered `scheduleFlush()` persisted.
 * - **Exit hooks**: SIGINT/SIGTERM/beforeExit run a final flush.
 * - **RSS gauge**: `rss()` feeds the bridge pong frames so the server can
 *   watch the in-memory dataset ceiling.
 */
import fs from "node:fs"

import { getDb } from "@/lib/db/schema"

import { ensureCliDb, type CliDbHandle } from "../db/bootstrap"
import type { DbLike } from "../db/snapshot"
import { durabilityRoot } from "./persistence/backend"
import { manifestFile, readManifest } from "./persistence/manifest"
import {
  openDurabilityStore,
  type DurabilityDbLike,
  type DurabilitySourceLike,
  type DurabilityStore,
} from "./persistence/store"
import { isDurabilityBackendId, type DurabilityBackendId } from "./persistence/types"

/** The Dexie surface the middleware needs (kept loose for tests). */
export interface DexieLike {
  use(middleware: { stack: "dbcore"; name: string; create(down: DbCoreLike): DbCoreLike }): unknown
}

interface DbCoreLike {
  table(name: string): DbCoreTableLike
  [key: string]: unknown
}

interface DbCoreTableLike {
  mutate(req: unknown): Promise<unknown>
  [key: string]: unknown
}

/**
 * Install the write-triggered flush middleware. Every table mutation
 * (add/put/delete/deleteRange) schedules `onWrite` after it settles.
 *
 * `ignoreTables` names tables whose mutations must NOT schedule a flush —
 * pass the same set the snapshot excludes, or an append-heavy excluded table
 * would drive full re-dumps that contain none of its rows.
 */
export function installWriteFlush(
  db: DexieLike,
  onWrite: (tableName: string) => void,
  opts: { ignoreTables?: readonly string[] } = {}
): void {
  const ignored = new Set(opts.ignoreTables ?? [])
  db.use({
    stack: "dbcore",
    name: "headless-write-flush",
    create(down) {
      return {
        ...down,
        table(name: string) {
          const table = down.table(name)
          if (ignored.has(name)) return table
          return {
            ...table,
            mutate(req: unknown) {
              const result = table.mutate(req)
              void Promise.resolve(result)
                .then(() => onWrite(name))
                .catch(() => {
                  // A failed mutation persisted nothing; skip the flush.
                })
              return result
            },
          }
        },
      }
    },
  })
}

/**
 * Which rung of the durability ladder this process runs on.
 *
 * Resolution order — the manifest wins, because once an account has been
 * migrated its files ARE that backend and an env var must not be able to boot
 * the brain against the wrong store:
 *
 *   1. `<home>/durability/<account>/backend-manifest.json` (if present)
 *   2. `COGNIA_DURABILITY_BACKEND` (the rollout gate)
 *   3. `snapshot-v3` — the pre-existing debounced table store
 */
export function resolveDurabilityBackend(
  home: string,
  accountId: string,
  env: Record<string, string | undefined> = process.env
): DurabilityBackendId {
  const root = durabilityRoot(home, accountId)
  if (fs.existsSync(manifestFile(root))) {
    try {
      return readManifest(root).activeBackend
    } catch {
      // A corrupt manifest is a `durability verify` problem, not a reason to
      // silently pick a different store. Fall through to the env gate, which
      // an operator sets deliberately.
    }
  }
  const requested = env.COGNIA_DURABILITY_BACKEND
  return isDurabilityBackendId(requested) ? requested : "snapshot-v3"
}

export interface DurabilityOptions {
  /** Snapshot directory (`~/.cognia/serve` by default at the call site). */
  home: string
  accountId: string
  debounceMs?: number
  /** Override the resolved backend (tests / explicit rollout). */
  backend?: DurabilityBackendId
  /** Injected env for backend resolution (tests). */
  env?: Record<string, string | undefined>
  /** Injected process for signal hooks (tests). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">
  /** Warn when the long-lived brain crosses this RSS ceiling. */
  rssWarningBytes?: number
  /** Injected alert sink (tests/embedding). */
  onRssWarning?: (rssBytes: number, limitBytes: number) => void
}

export interface DurabilityHandle {
  /** Present only on `snapshot-v3`; the journal/SQLite rungs own their own db. */
  db: CliDbHandle | null
  /** Which rung this process actually armed. */
  backend: DurabilityBackendId
  /** Schedule a debounced snapshot (also wired to every Dexie mutation). */
  notifyDbWrite: () => void
  /** RSS + last-flush gauge for the bridge pong frames. */
  rss(): { rssBytes: number; lastFlushAt: number }
  /** Final flush + detach signal hooks. Safe to call more than once. */
  dispose(): Promise<void>
}

/** The two databases the headless brain persists, in primary-first order. */
async function resolveDurabilitySources(): Promise<DurabilitySourceLike[]> {
  const { schedulerDb, SCHEDULER_DB_NAME, SCHEDULER_SNAPSHOT_EXCLUDED_TABLES } =
    await import("@/lib/scheduler/scheduler-db")
  const primary = getDb() as unknown as DurabilityDbLike
  return [
    { name: primary.name ?? "CogniaDB", db: primary },
    {
      name: SCHEDULER_DB_NAME,
      db: schedulerDb as unknown as DurabilityDbLike,
      excludeTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
    },
  ]
}

/**
 * `journal-v4` / `sqlite-v5` rungs.
 *
 * There is no debounce and no flush here — every committed Dexie transaction is
 * already on disk by the time it resolves, so `notifyDbWrite` is a no-op kept
 * only because `bootstrapHeadlessRuntimes` takes it as a required hook.
 */
async function startLedgerDurability(
  opts: DurabilityOptions,
  backend: DurabilityBackendId,
  proc: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">,
  readRss: () => number
): Promise<DurabilityHandle> {
  // Same contract as `ensureCliDb`'s `installGlobals` seam: `startDurability`
  // is reachable from tests and embedders that have not installed the shim, and
  // `getDb()` throws without `window`.
  const { installFakeIndexedDb } = await import("@/lib/headless/node-indexeddb")
  await installFakeIndexedDb()

  const store: DurabilityStore = await openDurabilityStore({
    home: opts.home,
    accountId: opts.accountId,
    getSources: resolveDurabilitySources,
    whenReady: async () => {
      const { whenSeeded } = await import("@/lib/db/schema")
      await whenSeeded()
    },
  })

  let disposed = false
  const onSignal = (): void => {
    void dispose()
  }
  proc.on("SIGINT", onSignal)
  proc.on("SIGTERM", onSignal)

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    proc.off?.("SIGINT", onSignal)
    proc.off?.("SIGTERM", onSignal)
    await store.close()
  }

  return {
    db: null,
    backend,
    notifyDbWrite: () => {},
    rss: () => ({ rssBytes: readRss(), lastFlushAt: store.sequence() }),
    dispose,
  }
}

/**
 * Open the snapshot-backed db for the account and arm the durability
 * ladder's v1 rungs.
 *
 * The write-flush middleware MUST attach before Dexie opens: `db.use()`
 * only records the middleware, and the dbcore stack is generated at open
 * time (`generateMiddlewareStacks`) — a post-open `use()` is inert until a
 * reopen, which is exactly the silent-persistence-loss bug the T-B3
 * hand-run surfaced. The `getDatabase` seam runs pre-open, so the hook
 * lands in the stack.
 */
export async function startDurability(opts: DurabilityOptions): Promise<DurabilityHandle> {
  const proc = opts.proc ?? process
  let lastFlushAt = 0
  const rssWarningBytes = opts.rssWarningBytes ?? 1_500 * 1024 * 1024
  const onRssWarning =
    opts.onRssWarning ??
    ((rssBytes: number, limitBytes: number) => {
      process.emitWarning(
        `cognia serve RSS ${rssBytes} bytes exceeded the ${limitBytes} byte durability ceiling`,
        { code: "COGNIA_SERVE_RSS_HIGH" }
      )
    })
  let rssWarningActive = false

  function readRss(): { rssBytes: number; lastFlushAt: number } {
    const rssBytes = proc.memoryUsage().rss
    if (rssBytes >= rssWarningBytes) {
      if (!rssWarningActive) onRssWarning(rssBytes, rssWarningBytes)
      rssWarningActive = true
    } else {
      rssWarningActive = false
    }
    return { rssBytes, lastFlushAt }
  }

  const backend =
    opts.backend ?? resolveDurabilityBackend(opts.home, opts.accountId, opts.env ?? process.env)
  if (backend !== "snapshot-v3") {
    return startLedgerDurability(opts, backend, proc, () => readRss().rssBytes)
  }

  // scheduleFlush becomes available only after ensureCliDb resolves; the
  // middleware (installed during ensureCliDb's open) reaches it via this ref.
  const handleRef: { current: CliDbHandle | null } = { current: null }
  const notifyDbWrite = (): void => {
    handleRef.current?.scheduleFlush()
  }

  const db = await ensureCliDb({
    home: opts.home,
    fileName: `db-${opts.accountId}.json`,
    debounceMs: opts.debounceMs,
    // BOTH databases: `CogniaDB` and the scheduler's separate
    // `CogniaSchedulerDB`. Without the second one a restarted brain reboots with
    // an empty schedule while still reporting the scheduler runtime as running.
    getDatabases: async () => {
      const { schedulerDb, SCHEDULER_DB_NAME, SCHEDULER_SNAPSHOT_EXCLUDED_TABLES } =
        await import("@/lib/scheduler/scheduler-db")
      const primary = getDb()
      installWriteFlush(primary as unknown as DexieLike, (tableName) =>
        handleRef.current?.scheduleTableFlush(primary.name, tableName)
      )
      installWriteFlush(
        schedulerDb as unknown as DexieLike,
        (tableName) => handleRef.current?.scheduleTableFlush(SCHEDULER_DB_NAME, tableName),
        {
          ignoreTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
        }
      )
      return [
        { name: primary.name, db: primary as unknown as DbLike },
        {
          name: SCHEDULER_DB_NAME,
          db: schedulerDb as unknown as DbLike,
          excludeTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
        },
      ]
    },
  })
  handleRef.current = db

  const flushAndStamp = async (): Promise<void> => {
    await db.flush()
    lastFlushAt = Date.now()
  }

  const onSignal = (): void => {
    void dispose().then(() => proc.off?.("SIGINT", onSignal))
  }
  const onBeforeExit = (): void => {
    void flushAndStamp()
  }
  proc.on("SIGINT", onSignal)
  proc.on("SIGTERM", onSignal)
  proc.on("beforeExit", onBeforeExit)

  let disposed = false
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    proc.off?.("SIGINT", onSignal)
    proc.off?.("SIGTERM", onSignal)
    proc.off?.("beforeExit", onBeforeExit)
    await flushAndStamp()
    await db.dispose()
  }

  return {
    db,
    backend,
    notifyDbWrite,
    rss: readRss,
    dispose,
  }
}
