import type { ActiveRunDispatchMode } from "@/types/connectors/policy"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConnectorInboundJobRow } from "./connector-types"
import { getDb } from "./schema"

const PENDING_STATUSES = new Set<ConnectorInboundJobRow["status"]>(["queued", "steering"])

function scopedPlatformMessageId(event: NormalizedInboundEvent): string {
  return `${event.conversationKey}\u001f${event.messageId}`
}

function inboundJobId(adapterId: string, platformMessageId: string): string {
  return `${adapterId}:inbound:${platformMessageId}`
}

export interface ConnectorInboundEnqueueResult {
  job: ConnectorInboundJobRow
  inserted: boolean
}

export async function ensureConnectorInboundJob(
  event: NormalizedInboundEvent,
  dispatchMode: ActiveRunDispatchMode,
  options: { now?: number; historyOnly?: boolean } = {}
): Promise<ConnectorInboundEnqueueResult> {
  const db = getDb()
  const platformMessageId = scopedPlatformMessageId(event)
  const existing = await db.connectorInboundJobs
    .where("[adapterId+platformMessageId]")
    .equals([event.adapterId, platformMessageId])
    .first()
  if (existing) return { job: existing, inserted: false }

  const now = options.now ?? Date.now()
  const row: ConnectorInboundJobRow = {
    id: inboundJobId(event.adapterId, platformMessageId),
    adapterId: event.adapterId,
    platformMessageId,
    sourceMessageId: event.messageId,
    conversationKey: event.conversationKey,
    event,
    dispatchMode,
    status: options.historyOnly ? "history_only" : dispatchMode === "steer" ? "steering" : "queued",
    attempts: 0,
    receivedAt: event.timestamp,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await db.connectorInboundJobs.add(row)
    return { job: row, inserted: true }
  } catch (error) {
    // Another transport delivery may win the unique insert between the read
    // and add. Dexie uses different constraint error classes in browser and
    // fake-indexeddb, so resolve by identity before deciding whether to throw.
    const duplicate = await db.connectorInboundJobs
      .where("[adapterId+platformMessageId]")
      .equals([event.adapterId, platformMessageId])
      .first()
    if (!duplicate) throw error
    return { job: duplicate, inserted: false }
  }
}

export async function enqueueConnectorInboundJob(
  event: NormalizedInboundEvent,
  dispatchMode: ActiveRunDispatchMode,
  options: { now?: number; historyOnly?: boolean } = {}
): Promise<ConnectorInboundJobRow> {
  return (await ensureConnectorInboundJob(event, dispatchMode, options)).job
}

export async function listPendingConnectorInboundJobs(
  conversationKey: string
): Promise<ConnectorInboundJobRow[]> {
  const rows = await getDb()
    .connectorInboundJobs.where("conversationKey")
    .equals(conversationKey)
    .filter((row) => PENDING_STATUSES.has(row.status))
    .toArray()
  return rows.sort((a, b) => a.receivedAt - b.receivedAt || a.createdAt - b.createdAt)
}

export async function countPendingConnectorInboundJobs(conversationKey: string): Promise<number> {
  return (await listPendingConnectorInboundJobs(conversationKey)).length
}

export async function listRecoverableConnectorInboundJobs(): Promise<ConnectorInboundJobRow[]> {
  const rows = await getDb()
    .connectorInboundJobs.where("status")
    .anyOf("queued", "steering")
    .toArray()
  return rows.sort((a, b) => a.receivedAt - b.receivedAt || a.createdAt - b.createdAt)
}

export async function updateConnectorInboundJobPayload(
  id: string,
  event: NormalizedInboundEvent,
  dispatchMode: ActiveRunDispatchMode,
  options: { now?: number } = {}
): Promise<void> {
  const current = await getDb().connectorInboundJobs.get(id)
  if (!current || !PENDING_STATUSES.has(current.status)) return
  await getDb().connectorInboundJobs.update(id, {
    event,
    dispatchMode,
    status: dispatchMode === "steer" ? "steering" : "queued",
    updatedAt: options.now ?? Date.now(),
  })
}

export async function claimConnectorInboundJob(
  id: string,
  options: { leaseOwner: string; leaseMs: number; now?: number }
): Promise<ConnectorInboundJobRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || !PENDING_STATUSES.has(current.status)) return undefined
    const now = options.now ?? Date.now()
    const claimed: ConnectorInboundJobRow = {
      ...current,
      status: "running",
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: now + options.leaseMs,
      attempts: current.attempts + 1,
      updatedAt: now,
    }
    await db.connectorInboundJobs.put(claimed)
    return claimed
  })
}

export async function claimNextConnectorInboundJob(
  conversationKey: string,
  options: { leaseOwner: string; leaseMs: number; now?: number }
): Promise<ConnectorInboundJobRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const next = (await listPendingConnectorInboundJobs(conversationKey))[0]
    if (!next) return undefined
    const now = options.now ?? Date.now()
    const claimed: ConnectorInboundJobRow = {
      ...next,
      status: "running",
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: now + options.leaseMs,
      attempts: next.attempts + 1,
      updatedAt: now,
    }
    await db.connectorInboundJobs.put(claimed)
    return claimed
  })
}

export async function completeConnectorInboundJob(
  id: string,
  options: { executionRunId?: string; now?: number } = {}
): Promise<void> {
  const changes: Partial<ConnectorInboundJobRow> = {
    status: "completed",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: options.now ?? Date.now(),
  }
  if (options.executionRunId !== undefined) changes.executionRunId = options.executionRunId
  await getDb().connectorInboundJobs.update(id, changes)
}

/**
 * Durably associate the model/tool execution with its inbound job before any
 * irreversible work begins. Recovery controls use this identity to avoid
 * replaying a run whose side effects may already have happened.
 */
export async function bindConnectorInboundJobExecutionRun(
  id: string,
  executionRunId: string,
  options: { now?: number } = {}
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || current.status !== "running") return false
    await db.connectorInboundJobs.update(id, {
      executionRunId,
      updatedAt: options.now ?? Date.now(),
    })
    return true
  })
}

export async function markConnectorInboundJobHistoryOnly(
  id: string,
  reason: string,
  options: { now?: number } = {}
): Promise<void> {
  await getDb().connectorInboundJobs.update(id, {
    status: "history_only",
    recoveryReason: reason,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: options.now ?? Date.now(),
  })
}

export async function markConnectorInboundJobRecoveryRequired(
  id: string,
  reason: string,
  options: { error?: string; now?: number } = {}
): Promise<void> {
  await getDb().connectorInboundJobs.update(id, {
    status: "recovery_required",
    recoveryReason: reason,
    lastError: options.error,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: options.now ?? Date.now(),
  })
}

export async function recoverStaleConnectorInboundJobs(
  options: { now?: number; reclaimAllRunning?: boolean } = {}
): Promise<number> {
  const db = getDb()
  const now = options.now ?? Date.now()
  const stale = await db.connectorInboundJobs
    .where("status")
    .equals("running")
    .filter(
      (row) =>
        options.reclaimAllRunning === true ||
        (row.leaseExpiresAt !== undefined && row.leaseExpiresAt <= now)
    )
    .toArray()
  for (const row of stale) {
    await db.connectorInboundJobs.update(row.id, {
      status: "recovery_required",
      recoveryReason:
        options.reclaimAllRunning === true
          ? "inbound_runtime_restarted"
          : "inbound_run_lease_expired",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
  }
  return stale.length
}

export async function continueConnectorInboundJobSafely(
  id: string,
  options: { now?: number } = {}
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || current.status !== "recovery_required") return false
    await db.connectorInboundJobs.update(id, {
      status: "steering",
      dispatchMode: "steer",
      event: {
        ...current.event,
        channelData: {
          ...current.event.channelData,
          dispatchIntent: "steer-replay",
          recoveryIntent: "continue_safely",
        },
      },
      recoveryReason: "operator_continue_at_safe_boundary",
      lastError: undefined,
      updatedAt: options.now ?? Date.now(),
    })
    return true
  })
}

export async function retryConnectorInboundJobFromStart(
  id: string,
  options: { confirmed: true; now?: number }
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || current.status !== "recovery_required") return false
    const channelData = { ...current.event.channelData }
    delete channelData.dispatchIntent
    delete channelData.recoveryIntent
    await db.connectorInboundJobs.update(id, {
      status: "queued",
      dispatchMode: "queue",
      event: { ...current.event, channelData },
      recoveryReason: "operator_retry_from_start",
      lastError: undefined,
      updatedAt: options.now ?? Date.now(),
    })
    return true
  })
}

export async function dismissConnectorInboundJobRecovery(
  id: string,
  options: { now?: number } = {}
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || current.status !== "recovery_required") return false
    await db.connectorInboundJobs.update(id, {
      status: "dismissed",
      recoveryReason: "operator_dismissed",
      updatedAt: options.now ?? Date.now(),
    })
    return true
  })
}
