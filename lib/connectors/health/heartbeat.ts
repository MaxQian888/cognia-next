/**
 * Periodic heartbeat probe (schema v45, im-refactored-crayon).
 *
 * Each running adapter has a 30-second timer that writes one
 * `adapter.heartbeat` audit row carrying the live `adapter.health()` snapshot
 * + pending outbound count. The Health Tab's 24h dot grid reads those rows
 * to colour intervals where no other event fired.
 *
 * Writer pruning: before each new heartbeat, rows older than 48 h with
 * `kind === "adapter.heartbeat"` are deleted for this adapter. The full
 * `connectorAudit` table is capped at 5 000 newest rows by the audit writer,
 * but heartbeats are noisy by design (2 880/day per adapter), so they get
 * their own per-adapter prune so a single quiet adapter doesn't push out
 * real audit data.
 */

import type { AdapterHealth, PlatformAdapter } from "@/types/connectors/adapter"
import { getDb } from "@/lib/db/schema"
import { appendAudit } from "@/lib/connectors/audit"
import { getAdapterRuntimeStateSnapshot } from "@/lib/connectors/outbound-runner"

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_RETENTION_MS = 48 * 60 * 60 * 1000

export interface HeartbeatHandle {
  /** Stop the heartbeat loop. Idempotent. */
  dispose(): void
}

export interface StartAdapterHeartbeatOptions {
  adapter: PlatformAdapter
  /** Override the interval (tests use a small value). */
  intervalMs?: number
  /** Override the retention window (tests use a small value). */
  retentionMs?: number
  /** Override the clock (tests). */
  now?: () => number
  /** Override the timer scheduler (tests). */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

async function pendingOutboundCount(adapterId: string): Promise<number> {
  // Dexie's `between` default is upper-open, so we count the two states
  // explicitly rather than relying on the lexical range — clearer intent
  // and immune to future status-enum reorderings.
  try {
    const db = getDb()
    const [pending, sending] = await Promise.all([
      db.outboundQueue.where("[adapterId+status]").equals([adapterId, "pending"]).count(),
      db.outboundQueue.where("[adapterId+status]").equals([adapterId, "sending"]).count(),
    ])
    return pending + sending
  } catch {
    return 0
  }
}

async function pruneHeartbeats(adapterId: string, cutoff: number): Promise<void> {
  // Use the standalone `at` index with a JS-side `adapterId` + `kind` check
  // instead of the compound `[adapterId+at]` index. A compound-key `between`
  // lower bound of `[adapterId, 0]` excludes rows whose `at` is negative
  // (legitimate in tests with synthetic clocks). The `at`-only index + JS
  // filter has equivalent selectivity for the heartbeat retention sweep.
  try {
    await getDb()
      .connectorAudit.where("at")
      .below(cutoff)
      .filter((row) => row.adapterId === adapterId && row.kind === "adapter.heartbeat")
      .delete()
  } catch {
    // Best-effort — a prune failure must not break the heartbeat loop.
  }
}

/**
 * Take one heartbeat snapshot now. Exported so callers (the Health tab
 * Reconnect-now button, integration tests) can force a probe without
 * waiting for the interval.
 */
export async function recordHeartbeatNow(
  adapter: PlatformAdapter,
  options: {
    now?: () => number
    retentionMs?: number
  } = {}
): Promise<AdapterHealth> {
  const now = (options.now ?? Date.now)()
  const retention = options.retentionMs ?? HEARTBEAT_RETENTION_MS
  await pruneHeartbeats(adapter.id, now - retention)

  let health: AdapterHealth
  try {
    health = adapter.health()
  } catch (err) {
    health = {
      state: "degraded",
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  const pending = await pendingOutboundCount(adapter.id)
  // Outbound-runner snapshot — `null` when the runner hasn't seen this
  // adapter send anything yet (lazy init). The Health Detail panel
  // renders neutral defaults in that case.
  const runtime = getAdapterRuntimeStateSnapshot(adapter.id)

  await appendAudit({
    adapterId: adapter.id,
    kind: "adapter.heartbeat",
    at: now,
    fields: {
      state: health.state,
      reason: health.reason,
      lastActivityAt: health.lastActivityAt,
      pendingOutboundCount: pending,
      breakerState: runtime?.breaker.state ?? null,
      breakerOpenedAt: runtime?.breaker.openedAt ?? null,
      breakerFailureRate: runtime?.breaker.recentFailureRate ?? null,
      breakerEventCount: runtime?.breaker.eventCount ?? null,
      rateAvailable: runtime?.bucket.available ?? null,
      rateCapacity: runtime?.bucket.capacity ?? null,
      rateRefillPerSec: runtime?.bucket.refillPerSec ?? null,
      rateNextRefillAt: runtime?.bucket.nextRefillAt ?? null,
    },
  }).catch(() => {
    // Audit writer failures must not break the loop.
  })

  return health
}

/**
 * Start a 30s heartbeat loop for `adapter`. Returns a disposer; callers
 * must call it on unmount / `adapter.stop()` to clear the interval.
 *
 * The first heartbeat fires immediately so the Health tab has a colour
 * to draw for the current 30 min bucket instead of waiting up to 30 s
 * for the first interval.
 */
export function startAdapterHeartbeat(options: StartAdapterHeartbeatOptions): HeartbeatHandle {
  const {
    adapter,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    retentionMs = HEARTBEAT_RETENTION_MS,
    now,
    scheduler = {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
  } = options

  let disposed = false

  void recordHeartbeatNow(adapter, { now, retentionMs }).catch(() => undefined)

  const handle = scheduler.setInterval(() => {
    if (disposed) return
    void recordHeartbeatNow(adapter, { now, retentionMs }).catch(() => undefined)
  }, intervalMs)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      scheduler.clearInterval(handle)
    },
  }
}
