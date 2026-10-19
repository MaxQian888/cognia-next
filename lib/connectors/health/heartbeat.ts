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
 * audit log a record of real events; the 48 h retention sweep below is the
 * heartbeat table's bound (an indexed `at` range delete drained in batches —
 * no JS `kind` filter, since the whole table is heartbeats).
 */

import type { AdapterHealth, PlatformAdapter } from "@/types/connectors/adapter"
import { getDb } from "@/lib/db/schema"
import { getAdapterRuntimeStateSnapshot } from "@/lib/connectors/outbound-runner"
import { getConnectorRuntimeSupervisor } from "@/lib/connectors/runtime-supervisor"

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_RETENTION_MS = 48 * 60 * 60 * 1000
export const HEARTBEAT_RETENTION_BATCH = 1000
/**
 * Upper bound on batches one sweep drains. The sweep runs once a day while
 * every adapter writes 2 880 rows a day, so a single 1 000-row batch let the
 * expired backlog grow by ~1 880 rows per adapter per day. Draining batch by
 * batch (one short transaction each) clears a normal day in a few batches;
 * the cap only stops a pathological backlog from monopolising one sweep, and
 * the next sweep resumes where this one stopped.
 */
export const HEARTBEAT_RETENTION_MAX_BATCHES = 500

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
    maxBatches?: number
  } = {}
): Promise<number> {
  const now = options.now ?? Date.now()
  const cutoff = now - (options.retentionMs ?? HEARTBEAT_RETENTION_MS)
  const batchLimit = Math.max(1, options.batchLimit ?? HEARTBEAT_RETENTION_BATCH)
  const maxBatches = Math.max(1, options.maxBatches ?? HEARTBEAT_RETENTION_MAX_BATCHES)
  const db = getDb()
  let deleted = 0
  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = (await db.connectorHeartbeats
      .where("at")
      .below(cutoff)
      .limit(batchLimit)
      .primaryKeys()) as string[]
    if (ids.length > 0) await db.connectorHeartbeats.bulkDelete(ids)
    deleted += ids.length
    if (ids.length < batchLimit) break
  }
  return deleted
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
