import type { ActiveRunDispatchMode } from "@/types/connectors/policy"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConnectorInboundJobRow } from "./connector-types"
import { getDb } from "./schema"

const PENDING_STATUSES = new Set<ConnectorInboundJobRow["status"]>(["queued", "steering"])

function inboundJobId(adapterId: string, platformMessageId: string): string {
  return `${adapterId}:inbound:${platformMessageId}`
}

export async function enqueueConnectorInboundJob(
  event: NormalizedInboundEvent,
  dispatchMode: ActiveRunDispatchMode,
  options: { now?: number; historyOnly?: boolean } = {}
): Promise<ConnectorInboundJobRow> {
  const db = getDb()
  const existing = await db.connectorInboundJobs
    .where("[adapterId+platformMessageId]")
    .equals([event.adapterId, event.messageId])
    .first()
  if (existing) return existing

  const now = options.now ?? Date.now()
  const row: ConnectorInboundJobRow = {
    id: inboundJobId(event.adapterId, event.messageId),
    adapterId: event.adapterId,
    platformMessageId: event.messageId,
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
    return row
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "ConstraintError") throw error
    const duplicate = await db.connectorInboundJobs
      .where("[adapterId+platformMessageId]")
      .equals([event.adapterId, event.messageId])
      .first()
    if (!duplicate) throw error
    return duplicate
  }
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
  await getDb().connectorInboundJobs.update(id, {
    status: "completed",
    executionRunId: options.executionRunId,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: options.now ?? Date.now(),
  })
}

export async function recoverStaleConnectorInboundJobs(
  options: { now?: number } = {}
): Promise<number> {
  const db = getDb()
  const now = options.now ?? Date.now()
  const stale = await db.connectorInboundJobs
    .where("status")
    .equals("running")
    .filter((row) => row.leaseExpiresAt !== undefined && row.leaseExpiresAt <= now)
    .toArray()
  for (const row of stale) {
    await db.connectorInboundJobs.update(row.id, {
      status: "recovery_required",
      recoveryReason: "inbound_run_lease_expired",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
  }
  return stale.length
}
