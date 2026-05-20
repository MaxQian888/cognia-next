/**
 * Daily cleanup for `connectorCallbackBindings`.
 *
 * Every A2UI surface the assistant sends through an adapter writes one
 * `ConnectorCallbackBindingRow` per interactive component so the inbound
 * parser can recover surface / component context when the user clicks a
 * button. Without cleanup the table grows without bound — a chatty
 * conversation that touches 10 surfaces/day with 5 buttons each adds 50
 * rows daily.
 *
 * `recordCallbackBinding` now sets a default `expiresAt = createdAt + 30 d`
 * for every new row, so the only thing missing is a periodic sweeper that
 * deletes rows whose `expiresAt` has passed. This module provides:
 *
 *   - `cleanupExpiredCallbackBindings()` — one-shot prune; returns the
 *     number of rows deleted. Safe to call from tests / manual debug.
 *   - `startCallbackBindingCleanupSchedule()` — starts a 24 h timer that
 *     runs the prune in the background and returns a disposer. The first
 *     prune fires after `initialDelayMs` (default 60 s) so it doesn't
 *     compete with app boot work.
 *
 * Legacy rows from before the `expiresAt` default are also reaped: any
 * row whose `expiresAt` is undefined AND whose `createdAt` is older than
 * `LEGACY_GRACE_MS` is treated as expired. This avoids leaking pre-v45
 * bindings forever while still giving long-lived surfaces from before
 * the default-TTL rollout a 60-day grace period.
 */

import { getDb } from "@/lib/db/schema"

/** Interval between cleanup sweeps. 24 h matches the OS-scheduler conventions used elsewhere. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Default delay before the first sweep, so we don't compete with app boot. */
export const CLEANUP_INITIAL_DELAY_MS = 60 * 1000

/**
 * Pre-default-TTL rows have `expiresAt === undefined`. Treat them as
 * expired when they're older than this window — long enough that any
 * surface still in flight resolves, short enough that orphans don't
 * accumulate for months.
 */
export const LEGACY_GRACE_MS = 60 * 24 * 60 * 60 * 1000

export interface CleanupResult {
  /** Rows whose explicit `expiresAt` had passed. */
  expiredCount: number
  /** Pre-default-TTL rows reaped via the legacy grace window. */
  legacyCount: number
  /** Total bindings deleted in this sweep. */
  total: number
}

/**
 * One-shot cleanup pass. Scans the `connectorCallbackBindings` table once
 * and removes both explicitly-expired rows and legacy rows older than the
 * grace window.
 */
export async function cleanupExpiredCallbackBindings(
  options: { now?: number; legacyGraceMs?: number } = {}
): Promise<CleanupResult> {
  const now = options.now ?? Date.now()
  const legacyCutoff = now - (options.legacyGraceMs ?? LEGACY_GRACE_MS)
  const db = getDb()

  let expiredCount = 0
  let legacyCount = 0
  const toDelete: string[] = []

  // One full-table scan is fine — the table is bounded by per-row TTL and
  // typically holds at most a few thousand entries. A compound index on
  // `expiresAt` would force a Dexie upgrade, and the table is small enough
  // that an in-memory filter is faster than the migration cost.
  await db.connectorCallbackBindings.each((row) => {
    if (typeof row.expiresAt === "number") {
      if (row.expiresAt < now) {
        expiredCount++
        toDelete.push(row.id)
      }
      return
    }
    // No explicit expiry — reap when older than the legacy grace window.
    if (row.createdAt < legacyCutoff) {
      legacyCount++
      toDelete.push(row.id)
    }
  })

  if (toDelete.length > 0) {
    await db.connectorCallbackBindings.bulkDelete(toDelete)
  }

  return { expiredCount, legacyCount, total: toDelete.length }
}

export interface CallbackBindingCleanupHandle {
  /** Stop the schedule. Idempotent. */
  dispose(): void
  /**
   * Force a sweep right now (skips the 24 h wait). Resolves with the
   * cleanup result so callers (manual debug, tests) can inspect.
   */
  runNow(): Promise<CleanupResult>
}

export interface StartCallbackBindingCleanupOptions {
  /** Override the interval (tests use a small value). Defaults to 24 h. */
  intervalMs?: number
  /** Override the initial delay (tests use 0). Defaults to 60 s. */
  initialDelayMs?: number
  /** Override the clock (tests). */
  now?: () => number
  /** Override the timer scheduler (tests). */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /**
   * Optional hook fired after each sweep. Useful for telemetry / audit
   * surfaces; failures inside the hook are swallowed so the schedule
   * cannot be derailed by a logger.
   */
  onSwept?: (result: CleanupResult) => void
}

/**
 * Start the daily cleanup schedule. Returns a handle the caller MUST
 * dispose on unmount / teardown so the timers don't leak. The first
 * sweep fires after `initialDelayMs`; subsequent sweeps fire on
 * `intervalMs` thereafter.
 */
export function startCallbackBindingCleanupSchedule(
  options: StartCallbackBindingCleanupOptions = {}
): CallbackBindingCleanupHandle {
  const {
    intervalMs = CLEANUP_INTERVAL_MS,
    initialDelayMs = CLEANUP_INITIAL_DELAY_MS,
    now,
    scheduler = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    onSwept,
  } = options

  let disposed = false
  let initialHandle: unknown = null
  let intervalHandle: unknown = null

  const sweep = async (): Promise<CleanupResult> => {
    const result = await cleanupExpiredCallbackBindings({ now: now?.() })
    try {
      onSwept?.(result)
    } catch {
      // Best-effort — telemetry failures must not break the schedule.
    }
    return result
  }

  initialHandle = scheduler.setTimeout(() => {
    if (disposed) return
    void sweep().catch((err) => {
      console.error(
        `[callback-binding-cleanup] initial sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
    intervalHandle = scheduler.setInterval(() => {
      if (disposed) return
      void sweep().catch((err) => {
        console.error(
          `[callback-binding-cleanup] periodic sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    }, intervalMs)
  }, initialDelayMs)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (initialHandle !== null) scheduler.clearTimeout(initialHandle)
      if (intervalHandle !== null) scheduler.clearInterval(intervalHandle)
    },
    async runNow(): Promise<CleanupResult> {
      return sweep()
    },
  }
}
