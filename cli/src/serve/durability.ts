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
import { getDb } from "@/lib/db/schema"

import { ensureCliDb, type CliDbHandle } from "../db/bootstrap"

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
 */
export function installWriteFlush(db: DexieLike, onWrite: () => void): void {
  db.use({
    stack: "dbcore",
    name: "headless-write-flush",
    create(down) {
      return {
        ...down,
        table(name: string) {
          const table = down.table(name)
          return {
            ...table,
            mutate(req: unknown) {
              const result = table.mutate(req)
              void Promise.resolve(result)
                .then(() => onWrite())
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

export interface DurabilityOptions {
  /** Snapshot directory (`~/.cognia/serve` by default at the call site). */
  home: string
  accountId: string
  debounceMs?: number
  /** Injected process for signal hooks (tests). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">
}

export interface DurabilityHandle {
  db: CliDbHandle
  /** Schedule a debounced snapshot (also wired to every Dexie mutation). */
  notifyDbWrite: () => void
  /** RSS + last-flush gauge for the bridge pong frames. */
  rss(): { rssBytes: number; lastFlushAt: number }
  /** Final flush + detach signal hooks. Safe to call more than once. */
  dispose(): Promise<void>
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
    getDatabase: () => {
      const dexie = getDb()
      installWriteFlush(dexie as unknown as DexieLike, notifyDbWrite)
      return dexie as unknown as ReturnType<typeof getDb>
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
    notifyDbWrite,
    rss: () => ({ rssBytes: proc.memoryUsage().rss, lastFlushAt }),
    dispose,
  }
}
