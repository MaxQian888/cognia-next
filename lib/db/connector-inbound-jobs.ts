import type { ActiveRunDispatchMode } from "@/types/connectors/policy"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConnectorInboundJobRow } from "./connector-types"
import { getDb, withDbReopenRetry } from "./schema"

const PENDING_STATUSES = new Set<ConnectorInboundJobRow["status"]>(["queued", "steering"])
const COMPLETABLE_STATUSES = new Set<ConnectorInboundJobRow["status"]>([
  "queued",
  "running",
  "steering",
])

export const INBOUND_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const INBOUND_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const INBOUND_RETENTION_SWEEP_BATCH = 500

function compactTerminalEvent(
  event: NormalizedInboundEvent,
  options: { retainRecoveryChannelData?: boolean } = {}
): NormalizedInboundEvent {
  const { raw: _raw, channelData, ...identity } = event
  const segments = event.segments.map((segment) => {
    if (segment.type !== "image" || segment.dataBase64 === undefined) return segment
    const { dataBase64: _dataBase64, ...withoutInlineBytes } = segment
    return withoutInlineBytes
  })
  const compacted = {
    ...identity,
    segments,
    ...(options.retainRecoveryChannelData && channelData ? { channelData } : {}),
  }
  // Active jobs always carry `raw`; terminal rows intentionally do not. The
  // shared event type remains unchanged so every adapter parser keeps one
  // strict input contract, while this persistence-only projection is smaller.
  return compacted as NormalizedInboundEvent
}

async function updateTerminalJob(
  id: string,
  changes: Partial<ConnectorInboundJobRow>,
  options: {
    retainRecoveryChannelData?: boolean
    allowedStatuses?: ReadonlySet<ConnectorInboundJobRow["status"]>
  } = {}
): Promise<void> {
  await withDbReopenRetry(async () => {
    const db = getDb()
    await db.transaction("rw", db.connectorInboundJobs, async () => {
      const current = await db.connectorInboundJobs.get(id)
      if (!current) return
      if (options.allowedStatuses && !options.allowedStatuses.has(current.status)) return
      await db.connectorInboundJobs.update(id, {
        ...changes,
        event: compactTerminalEvent(current.event, options),
      })
    })
  })
}

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
  const platformMessageId = scopedPlatformMessageId(event)
  const now = options.now ?? Date.now()
  const row: ConnectorInboundJobRow = {
    id: inboundJobId(event.adapterId, platformMessageId),
    adapterId: event.adapterId,
    platformMessageId,
    sourceMessageId: event.messageId,
    conversationKey: event.conversationKey,
    event: options.historyOnly ? compactTerminalEvent(event) : event,
    dispatchMode,
    status: options.historyOnly ? "history_only" : dispatchMode === "steer" ? "steering" : "queued",
    attempts: 0,
    receivedAt: event.timestamp,
    createdAt: now,
    updatedAt: now,
  }
  return withDbReopenRetry(async () => {
    const db = getDb()
    const existing = await db.connectorInboundJobs
      .where("[adapterId+platformMessageId]")
      .equals([event.adapterId, platformMessageId])
      .first()
    if (existing) return { job: existing, inserted: false }
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
  })
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
  await withDbReopenRetry(async () => {
    const db = getDb()
    const current = await db.connectorInboundJobs.get(id)
    if (!current || !PENDING_STATUSES.has(current.status)) return
    await db.connectorInboundJobs.update(id, {
      event,
      dispatchMode,
      status: dispatchMode === "steer" ? "steering" : "queued",
      updatedAt: options.now ?? Date.now(),
    })
  })
}

export async function claimConnectorInboundJob(
  id: string,
  options: { leaseOwner: string; leaseMs: number; now?: number }
): Promise<ConnectorInboundJobRow | undefined> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.connectorInboundJobs, () =>
      db.connectorInboundJobs.get(id).then((current) => {
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
        return db.connectorInboundJobs.put(claimed).then(() => claimed)
      })
    )
  })
}

export async function claimNextConnectorInboundJob(
  conversationKey: string,
  options: { leaseOwner: string; leaseMs: number; now?: number }
): Promise<ConnectorInboundJobRow | undefined> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.connectorInboundJobs, () =>
      db.connectorInboundJobs
        .where("conversationKey")
        .equals(conversationKey)
        .filter((row) => PENDING_STATUSES.has(row.status))
        .toArray()
        .then((rows) => {
          const next = rows.sort(
            (a, b) => a.receivedAt - b.receivedAt || a.createdAt - b.createdAt
          )[0]
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
          return db.connectorInboundJobs.put(claimed).then(() => claimed)
        })
    )
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
  await updateTerminalJob(id, changes, { allowedStatuses: COMPLETABLE_STATUSES })
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
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.connectorInboundJobs, () =>
      db.connectorInboundJobs.get(id).then((current) => {
        if (!current || current.status !== "running") return false
        return db.connectorInboundJobs
          .update(id, {
            executionRunId,
            updatedAt: options.now ?? Date.now(),
          })
          .then(() => true)
      })
    )
  })
}

/**
 * Durably record which Cognia account/principal the job's event resolved to
 * (Lark unified identity, plan 2026-07-24 P1.4). Called by the bus principal
 * step after a positive resolution; downstream consumers (Execution Run
 * initiator stamping) read the fields off the job row instead of re-resolving.
 */
export async function stampConnectorInboundJobPrincipal(
  id: string,
  stamp: { accountId: string; principalId: string },
  options: { now?: number } = {}
): Promise<void> {
  await withDbReopenRetry(() =>
    getDb().connectorInboundJobs.update(id, {
      accountId: stamp.accountId,
      principalId: stamp.principalId,
      updatedAt: options.now ?? Date.now(),
    })
  )
}

export async function markConnectorInboundJobHistoryOnly(
  id: string,
  reason: string,
  options: { now?: number } = {}
): Promise<void> {
  await updateTerminalJob(id, {
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
  await updateTerminalJob(
    id,
    {
      status: "recovery_required",
      recoveryReason: reason,
      lastError: options.error,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: options.now ?? Date.now(),
    },
    { retainRecoveryChannelData: true }
  )
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
      event: compactTerminalEvent(row.event, { retainRecoveryChannelData: true }),
    })
  }
  return stale.length
}

export async function continueConnectorInboundJobSafely(
  id: string,
  options: { now?: number; recoveryAnchor?: Record<string, unknown> } = {}
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (!current || current.status !== "recovery_required") return false
    const continuationText =
      "Continue from the persisted session at the last verified safe boundary. Do not repeat the original user request or completed tool calls."
    const channelData = { ...current.event.channelData }
    // A recovery turn must enter the canonical replay path. Retaining this
    // hint lets the bus live-steer it into an unrelated active run before the
    // recovery anchor and drift checks execute.
    delete channelData.activeRunDispatchMode
    await db.connectorInboundJobs.update(id, {
      status: "steering",
      dispatchMode: "steer",
      event: {
        ...current.event,
        plainText: continuationText,
        segments: [{ type: "text", text: continuationText }],
        channelData: {
          ...channelData,
          dispatchIntent: "steer-replay",
          recoveryIntent: "continue_safely",
          ...(options.recoveryAnchor ? { recoveryAnchor: options.recoveryAnchor } : {}),
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
      event: compactTerminalEvent(current.event),
    })
    return true
  })
}

/** Delete terminal inbound history using the 7/30-day retention tiers. */
export async function sweepTerminalConnectorInboundJobs(
  options: {
    now?: number
    historyRetentionMs?: number
    recoveryRetentionMs?: number
    batchLimit?: number
  } = {}
): Promise<number> {
  const now = options.now ?? Date.now()
  const historyCutoff = now - (options.historyRetentionMs ?? INBOUND_HISTORY_RETENTION_MS)
  const recoveryCutoff = now - (options.recoveryRetentionMs ?? INBOUND_RECOVERY_RETENTION_MS)
  const batchLimit = options.batchLimit ?? INBOUND_RETENTION_SWEEP_BATCH
  const db = getDb()
  const candidates: ConnectorInboundJobRow[] = []
  const collect = async (status: ConnectorInboundJobRow["status"], cutoff: number) => {
    if (candidates.length >= batchLimit) return
    candidates.push(
      ...(await db.connectorInboundJobs
        .where("[status+updatedAt]")
        .between([status, -Infinity], [status, cutoff], true, true)
        .limit(batchLimit - candidates.length)
        .toArray())
    )
  }
  for (const status of ["completed", "history_only", "dismissed"] as const) {
    await collect(status, historyCutoff)
  }
  for (const status of ["failed", "recovery_required"] as const) {
    await collect(status, recoveryCutoff)
  }
  const victims = candidates
    .filter((row) => row.leaseExpiresAt === undefined || row.leaseExpiresAt <= now)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(0, batchLimit)
  if (victims.length > 0) {
    await db.connectorInboundJobs.bulkDelete(victims.map((row) => row.id))
  }
  return victims.length
}
