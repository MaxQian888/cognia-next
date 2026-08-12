/**
 * Periodic heartbeat probe (schema v45; moved to a dedicated table at v51).
 *
 * Each running adapter gets one heartbeat every 30 s carrying the live
 * `adapter.health()` snapshot + pending outbound count. The Health Tab's 24h
 * dot grid reads those rows to colour intervals where no other event fired.
 *
 * Storage: heartbeats are written to the dedicated `connectorHeartbeats`
 * table, NOT `connectorAudit`. At 2 880 rows/day per adapter they used to
 * churn the audit writer's global 5 000-row `pruneOldest` on every append
 * and evict real operator-visible events. The dedicated table keeps the
 * audit log a record of real events; the 48 h per-adapter retention sweep
 * below is the heartbeat table's bound (an indexed `[adapterId+at]` range
 * delete — no JS `kind` filter, since the whole table is heartbeats).
 */

import type { AdapterHealth, PlatformAdapter } from "@/types/connectors/adapter"
import { getDb } from "@/lib/db/schema"
import { getAdapterRuntimeStateSnapshot } from "@/lib/connectors/outbound-runner"
import { getConnectorRuntimeSupervisor } from "@/lib/connectors/runtime-supervisor"

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_RETENTION_MS = 48 * 60 * 60 * 1000
export const HEARTBEAT_RETENTION_BATCH = 1000

async function pendingOutboundCount(adapterId: string): Promise<number> {
  // Dexie's `between` default is upper-open, so we count the two states
  // explicitly rather than relying on the lexical range — clearer intent
  // and immune to future status-enum reorderings.
  try {
    const db = getDb()
    const [pending, failed, sending] = await Promise.all([
      db.outboundQueue.where("[adapterId+status]").equals([adapterId, "pending"]).count(),
      db.outboundQueue.where("[adapterId+status]").equals([adapterId, "failed"]).count(),
      db.outboundQueue.where("[adapterId+status]").equals([adapterId, "sending"]).count(),
    ])
    return pending + failed + sending
  } catch {
    return 0
  }
}

export async function sweepConnectorHeartbeats(
  options: {
    now?: number
    retentionMs?: number
    batchLimit?: number
  } = {}
): Promise<number> {
  const now = options.now ?? Date.now()
  const cutoff = now - (options.retentionMs ?? HEARTBEAT_RETENTION_MS)
  const batchLimit = options.batchLimit ?? HEARTBEAT_RETENTION_BATCH
  const db = getDb()
  const ids = (await db.connectorHeartbeats
    .where("at")
    .below(cutoff)
    .limit(batchLimit)
    .primaryKeys()) as string[]
  if (ids.length > 0) await db.connectorHeartbeats.bulkDelete(ids)
  return ids.length
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
  let health: AdapterHealth
  try {
    health = adapter.health()
  } catch (err) {
    health = {
      state: "degraded",
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  getConnectorRuntimeSupervisor().refreshHealth(adapter.id, "heartbeat", health)
  const pending = await pendingOutboundCount(adapter.id)
  // Outbound-runner snapshot — `null` when the runner hasn't seen this
  // adapter send anything yet (lazy init). The Health Detail panel
  // renders neutral defaults in that case.
  const runtime = getAdapterRuntimeStateSnapshot(adapter.id)

  await getDb()
    .connectorHeartbeats.put({
      id: crypto.randomUUID(),
      adapterId: adapter.id,
      kind: "adapter.heartbeat",
      at: now,
      reason: health.reason,
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
    })
    .catch(() => {
      // Heartbeat-table write failures must not break the loop.
    })

  return health
}
