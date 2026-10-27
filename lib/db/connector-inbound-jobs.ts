import type { ActiveRunDispatchMode } from "@/types/connectors/policy"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { CONVERSATION_KEY_SEP } from "@/types/connectors/event"
import type { ConnectorInboundJobRow } from "./connector-types"
import { getDb, withDbReopenRetry } from "./schema"
import {
  inboundEditRevision,
  isNewerInboundEdit,
  mutationConversationMatches,
  isAuthorizedInboundEdit,
} from "@/lib/connectors/inbound-revision"

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
        pendingEdit: current.pendingEdit
          ? compactTerminalEvent(current.pendingEdit, options)
          : undefined,
        pendingEditsBySender: current.pendingEditsBySender
          ? Object.fromEntries(
              Object.entries(current.pendingEditsBySender).map(([sender, edit]) => [
                sender,
                compactTerminalEvent(edit, options),
              ])
            )
          : undefined,
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

function selectMatrixEdit(
  job: ConnectorInboundJobRow,
  author?: string
): NormalizedInboundEvent | undefined {
  return Object.values(job.matrixEditRevisions ?? {})
    .filter(
      (edit) =>
        !job.matrixRedactedEditIds?.includes(edit.messageId) &&
        (author === undefined || isAuthorizedInboundEdit(edit, author))
    )
    .reduce<NormalizedInboundEvent | undefined>(
      (latest, edit) =>
        !latest || isNewerInboundEdit(inboundEditRevision(edit), inboundEditRevision(latest))
          ? edit
          : latest,
      undefined
    )
}

function mutationStamp(job: ConnectorInboundJobRow, now = Date.now()) {
  return { mutationRevision: (job.mutationRevision ?? 0) + 1, updatedAt: now }
}

export async function listConnectorInboundMutationJobs(): Promise<ConnectorInboundJobRow[]> {
  return getDb()
    .connectorInboundJobs.filter(
      (job) =>
        (job.recalledAt !== undefined ||
          job.pendingEdit !== undefined ||
          job.matrixEditRevisions !== undefined) &&
        (job.mutationRevision === undefined
          ? job.appliedMutationRevision === undefined
          : job.mutationRevision > (job.appliedMutationRevision ?? 0))
    )
    .toArray()
}

export async function acknowledgeConnectorInboundMutation(
  id: string,
  revision?: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.connectorInboundJobs, async () => {
    const current = await db.connectorInboundJobs.get(id)
    if (current && current.mutationRevision === revision)
      await db.connectorInboundJobs.update(id, { appliedMutationRevision: revision ?? 0 })
  })
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
    const acceptExisting = async (
      existing: ConnectorInboundJobRow
    ): Promise<ConnectorInboundEnqueueResult> => {
      if (
        (event.kind ?? "create") !== "create" ||
        existing.event.kind !== "edit" ||
        options.historyOnly
      ) {
        return { job: existing, inserted: false }
      }
      // A transport edit can beat even the create's durable enqueue. Promote
      // its terminal placeholder exactly once when the create catches up.
      return db.transaction("rw", db.connectorInboundJobs, async () => {
        const current = await db.connectorInboundJobs.get(existing.id)
        if (!current || current.event.kind !== "edit" || current.recalledAt !== undefined) {
          return { job: current ?? existing, inserted: false }
        }
        const candidate =
          current.matrixEditRevisions !== undefined
            ? selectMatrixEdit(current, event.sender.remoteUserId)
            : (current.pendingEditsBySender?.[event.sender.remoteUserId] ?? current.pendingEdit)
        const promoted = {
          ...row,
          matrixEditRevisions: current.matrixEditRevisions,
          matrixRedactedEditIds: current.matrixRedactedEditIds,
          mutationRevision: current.mutationRevision,
          appliedMutationRevision: current.appliedMutationRevision,
          pendingEdit:
            candidate && isAuthorizedInboundEdit(candidate, event.sender.remoteUserId)
              ? candidate
              : undefined,
        }
        await db.connectorInboundJobs.put(promoted)
        return { job: promoted, inserted: true }
      })
    }
    const existing = await db.connectorInboundJobs
      .where("[adapterId+platformMessageId]")
      .equals([event.adapterId, platformMessageId])
      .first()
    if (existing) return acceptExisting(existing)
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
      return acceptExisting(duplicate)
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

/** Reuse the durable occurrence ledger so a queued create cannot outrun recall. */
export async function recordConnectorInboundRecall(
  event: NormalizedInboundEvent,
  now: number
): Promise<ConnectorInboundJobRow[]> {
  if (!event.replacesMessageId) return []
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.connectorInboundJobs, async () => {
      await ensureConnectorInboundJob({ ...event, messageId: event.replacesMessageId! }, "queue", {
        now,
        historyOnly: true,
      })
      const jobs = await db.connectorInboundJobs
        .where("adapterId")
        .equals(event.adapterId)
        .filter(
          (job) =>
            job.event.platform === event.platform &&
            mutationConversationMatches(event.conversationKey, job.conversationKey)
        )
        .toArray()
      const affected: ConnectorInboundJobRow[] = []
      for (const job of jobs) {
        if (job.sourceMessageId === event.replacesMessageId && job.recalledAt === undefined) {
          await db.connectorInboundJobs.update(job.id, {
            recalledAt: now,
            ...mutationStamp(job, now),
          })
        }
        if (
          event.platform === "matrix" &&
          job.matrixEditRevisions?.[event.replacesMessageId!] &&
          !job.matrixRedactedEditIds?.includes(event.replacesMessageId!)
        ) {
          const next = {
            ...job,
            matrixRedactedEditIds: [...(job.matrixRedactedEditIds ?? []), event.replacesMessageId!],
          }
          next.pendingEdit = selectMatrixEdit(
            next,
            (job.event.kind ?? "create") === "create" ? job.event.sender.remoteUserId : undefined
          )
          Object.assign(next, mutationStamp(job, now))
          await db.connectorInboundJobs.put(next)
          affected.push(next)
        }
      }
      return affected
    })
  })
}

export async function findConnectorInboundMutation(
  event: NormalizedInboundEvent
): Promise<ConnectorInboundJobRow | undefined> {
  const segments = event.conversationKey.split(CONVERSATION_KEY_SEP)
  const keys = segments.map((_, index) => [
    event.adapterId,
    `${segments.slice(0, index + 1).join(CONVERSATION_KEY_SEP)}\u001f${event.messageId}`,
  ])
  const rows = await getDb()
    .connectorInboundJobs.where("[adapterId+platformMessageId]")
    .anyOf(keys)
    .filter(
      (job) =>
        job.event.platform === event.platform &&
        mutationConversationMatches(job.conversationKey, event.conversationKey) &&
        (job.recalledAt !== undefined ||
          job.pendingEdit !== undefined ||
          job.matrixEditRevisions !== undefined)
    )
    .toArray()
  const applicable = rows
    .map((job) => {
      if (event.platform !== "matrix") return job
      const candidate =
        job.matrixEditRevisions !== undefined
          ? selectMatrixEdit(job, event.sender.remoteUserId)
          : (job.pendingEditsBySender?.[event.sender.remoteUserId] ?? job.pendingEdit)
      return {
        ...job,
        pendingEdit:
          candidate && isAuthorizedInboundEdit(candidate, event.sender.remoteUserId)
            ? candidate
            : undefined,
      }
    })
    .filter(
      (job) =>
        job.recalledAt !== undefined ||
        job.pendingEdit !== undefined ||
        job.matrixEditRevisions !== undefined
    )
  return (
    applicable.find((job) => job.recalledAt !== undefined) ??
    applicable.reduce<ConnectorInboundJobRow | undefined>(
      (latest, job) =>
        !latest?.pendingEdit ||
        (job.pendingEdit &&
          isNewerInboundEdit(
            inboundEditRevision(job.pendingEdit),
            inboundEditRevision(latest.pendingEdit)
          ))
          ? job
          : latest,
      undefined
    )
  )
}

export async function recordConnectorInboundEdit(event: NormalizedInboundEvent): Promise<void> {
  if (!event.replacesMessageId) return
  await withDbReopenRetry(async () => {
    const db = getDb()
    await db.transaction("rw", db.connectorInboundJobs, async () => {
      await ensureConnectorInboundJob({ ...event, messageId: event.replacesMessageId! }, "queue", {
        historyOnly: true,
      })
      const jobs = await db.connectorInboundJobs
        .where("adapterId")
        .equals(event.adapterId)
        .filter(
          (job) =>
            job.sourceMessageId === event.replacesMessageId &&
            job.event.platform === event.platform &&
            mutationConversationMatches(event.conversationKey, job.conversationKey)
        )
        .toArray()
      const recalledEdit =
        event.platform === "matrix"
          ? await findConnectorInboundMutation({ ...event, messageId: event.messageId })
          : undefined
      for (const job of jobs) {
        if (job.recalledAt !== undefined) continue
        if (event.platform === "matrix") {
          const knownAuthor = (job.event.kind ?? "create") === "create"
          if (knownAuthor && !isAuthorizedInboundEdit(event, job.event.sender.remoteUserId))
            continue
          if (job.matrixEditRevisions?.[event.messageId]) continue
          const history = {
            ...(job.pendingEdit ? { [job.pendingEdit.messageId]: job.pendingEdit } : {}),
            ...job.matrixEditRevisions,
            [event.messageId]: event,
          }
          const next = {
            ...job,
            matrixEditRevisions: history,
            matrixRedactedEditIds: [
              ...new Set([
                ...(job.matrixRedactedEditIds ?? []),
                ...(recalledEdit?.recalledAt !== undefined ? [event.messageId] : []),
              ]),
            ],
            ...mutationStamp(job),
          }
          next.pendingEdit = selectMatrixEdit(
            next,
            knownAuthor ? job.event.sender.remoteUserId : undefined
          )
          await db.connectorInboundJobs.put(next)
          continue
        }
        if (job.pendingEdit) {
          const incoming = inboundEditRevision(event),
            prior = inboundEditRevision(job.pendingEdit)
          if (!isNewerInboundEdit(incoming, prior)) continue
          if (
            event.messageId === job.pendingEdit.messageId &&
            incoming.at === prior.at &&
            incoming.order === prior.order &&
            event.plainText === job.pendingEdit.plainText
          ) {
            try {
              if (JSON.stringify(event.segments) === JSON.stringify(job.pendingEdit.segments))
                continue
            } catch {
              /* Malformed optional payloads must not prevent mutation containment. */
            }
          }
        }
        await db.connectorInboundJobs.update(job.id, { pendingEdit: event, ...mutationStamp(job) })
      }
    })
  })
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
    return db.transaction("rw", db.connectorInboundJobs, db.messages, async () => {
      // A late create can promote a terminal placeholder after collection.
      // Re-read eligibility atomically with deletion, preserving active work.
      const current = await db.connectorInboundJobs.bulkGet(victims.map((row) => row.id))
      const eligible: ConnectorInboundJobRow[] = []
      for (const row of current) {
        if (!row || (row.leaseExpiresAt !== undefined && row.leaseExpiresAt > now)) continue
        const cutoff =
          row.status === "completed" || row.status === "history_only" || row.status === "dismissed"
            ? historyCutoff
            : row.status === "failed" || row.status === "recovery_required"
              ? recoveryCutoff
              : undefined
        if (cutoff === undefined || row.updatedAt > cutoff) continue
        if ((row.mutationRevision ?? 0) > (row.appliedMutationRevision ?? 0)) {
          const canonical = await db.messages
            .where("platformMessageId")
            .equals(row.sourceMessageId)
            .filter((message) => {
              const pm = message.metadata?.platformMessage
              return (
                pm?.platform === row.event.platform &&
                pm.adapterId === row.adapterId &&
                typeof pm.conversationKey === "string" &&
                mutationConversationMatches(row.conversationKey, pm.conversationKey)
              )
            })
            .first()
          if (canonical) continue
        }
        eligible.push(row)
      }
      await db.connectorInboundJobs.bulkDelete(eligible.map((row) => row.id))
      return eligible.length
    })
  }
  return victims.length
}
