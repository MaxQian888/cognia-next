import {
  activateValidatedGeneration,
  canClaimRetrievalJob,
  claimRetrievalJob,
  createIndexGeneration,
  createRetrievalJob,
  fingerprintRetrievalProfile,
  heartbeatRetrievalJob,
  transitionRetrievalJob,
  type IndexGenerationValidation,
  type RetrievalJobStatus,
  type RetrievalProfileV1,
} from "@cognia/rag"

import { getDb } from "./schema"
import type {
  RetrievalEncryptedContentRow,
  RetrievalGenerationRow,
  RetrievalJobRow,
  RetrievalMigrationJournalRow,
  RetrievalProfileRow,
  RetrievalTombstoneRow,
  RetrievalTraceRow,
} from "./retrieval-control-types"

const ACTIVE_JOB_STATUSES: RetrievalJobStatus[] = ["queued", "running", "retry_wait"]

export async function saveRetrievalProfile(
  profile: RetrievalProfileV1,
  now: number = Date.now()
): Promise<RetrievalProfileRow> {
  const db = getDb()
  const fingerprint = await fingerprintRetrievalProfile(profile)
  return db.transaction("rw", db.retrievalProfiles, async () => {
    const existing = await db.retrievalProfiles.get(profile.id)
    const row: RetrievalProfileRow = {
      id: profile.id,
      schemaVersion: 1,
      fingerprint,
      profile,
      active: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await db.retrievalProfiles.put(row)
    return row
  })
}

export async function stageRetrievalGeneration(
  input: Omit<RetrievalGenerationRow, "status" | "validation">
): Promise<RetrievalGenerationRow> {
  const row = createIndexGeneration(input)
  await getDb().retrievalGenerations.add(row)
  return row
}

export async function markRetrievalGenerationValidating(
  id: string,
  validation: IndexGenerationValidation
): Promise<RetrievalGenerationRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalGenerations, async () => {
    const row = await db.retrievalGenerations.get(id)
    if (!row || row.status !== "staging") {
      throw new Error("Only a staging retrieval generation can be validated")
    }
    const next: RetrievalGenerationRow = { ...row, status: "validating", validation }
    await db.retrievalGenerations.put(next)
    return next
  })
}

export async function failRetrievalGeneration(
  id: string,
  failureCode: string,
  now: number = Date.now()
): Promise<RetrievalGenerationRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalGenerations, async () => {
    const row = await db.retrievalGenerations.get(id)
    if (!row) throw new Error("Retrieval generation not found")
    if (row.status === "active" || row.status === "retiring") {
      throw new Error("An activated retrieval generation cannot be failed")
    }
    const failed: RetrievalGenerationRow = {
      ...row,
      status: "failed",
      failedAt: now,
      validation: {
        count: row.validation?.count ?? 0,
        contentHash: row.validation?.contentHash ?? "unknown",
        dimensions: row.validation?.dimensions,
        valid: false,
        failureCode,
      },
    }
    await db.retrievalGenerations.put(failed)
    return failed
  })
}

export async function getActiveRetrievalGeneration(
  corpusId: string
): Promise<RetrievalGenerationRow | undefined> {
  const db = getDb()
  const pointer = await db.retrievalActivePointers.get(corpusId)
  return pointer ? db.retrievalGenerations.get(pointer.generationId) : undefined
}

export async function activateRetrievalGeneration(
  id: string,
  now: number = Date.now()
): Promise<RetrievalGenerationRow> {
  const db = getDb()
  return db.transaction("rw", [db.retrievalGenerations, db.retrievalActivePointers], async () => {
    const next = await db.retrievalGenerations.get(id)
    if (!next) throw new Error("Retrieval generation not found")
    const pointer = await db.retrievalActivePointers.get(next.corpusId)
    const previous = pointer ? await db.retrievalGenerations.get(pointer.generationId) : undefined
    const switched = activateValidatedGeneration(next, previous, now)
    await db.retrievalGenerations.put(switched.active)
    if (switched.retired) await db.retrievalGenerations.put(switched.retired)
    await db.retrievalActivePointers.put({
      corpusId: switched.active.corpusId,
      generationId: switched.active.id,
      domain: switched.active.domain,
      profileFingerprint: switched.active.profileFingerprint,
      updatedAt: now,
    })
    return switched.active
  })
}

export type RetrievalJobDraft = Omit<
  RetrievalJobRow,
  "status" | "attempt" | "startedAt" | "completedAt" | "leaseOwner" | "leaseExpiresAt"
>

export async function enqueueRetrievalJob(draft: RetrievalJobDraft): Promise<RetrievalJobRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalJobs, async () => {
    const duplicates = await db.retrievalJobs.where("dedupeKey").equals(draft.dedupeKey).toArray()
    const active = duplicates.find((job) => ACTIVE_JOB_STATUSES.includes(job.status))
    if (active) return active
    const row = createRetrievalJob(draft)
    await db.retrievalJobs.add(row)
    return row
  })
}

export async function cancelStoredRetrievalJob(
  id: string,
  now: number = Date.now()
): Promise<RetrievalJobRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalJobs, async () => {
    const job = await db.retrievalJobs.get(id)
    if (!job) throw new Error("Retrieval job not found")
    if (!ACTIVE_JOB_STATUSES.includes(job.status)) {
      throw new Error("Only active retrieval jobs can be cancelled")
    }
    const cancelled = transitionRetrievalJob(job, "cancelled", now, {
      cancellationRequestedAt: now,
      resultCode: "user_cancelled",
    })
    await db.retrievalJobs.put(cancelled)
    return cancelled
  })
}

export async function retryStoredRetrievalJob(
  id: string,
  input: { id: string; now?: number }
): Promise<RetrievalJobRow> {
  const db = getDb()
  const previous = await db.retrievalJobs.get(id)
  if (!previous) throw new Error("Retrieval job not found")
  if (previous.status !== "failed" && previous.status !== "cancelled") {
    throw new Error("Only failed or cancelled retrieval jobs can be retried")
  }
  if (!input.id || input.id === previous.id) {
    throw new Error("A new retrieval job id is required for manual retry")
  }
  const now = input.now ?? Date.now()
  return enqueueRetrievalJob({
    id: input.id,
    dedupeKey: `${previous.dedupeKey}:manual-retry:${input.id}`,
    kind: previous.kind,
    corpusId: previous.corpusId,
    profileFingerprint: previous.profileFingerprint,
    generationId: previous.generationId,
    queuedAt: now,
    maxAttempts: previous.maxAttempts,
  })
}

export interface RetrievalControlSnapshot {
  generations: RetrievalGenerationRow[]
  jobs: RetrievalJobRow[]
  traces: RetrievalTraceRow[]
  tombstones: RetrievalTombstoneRow[]
  migrations: RetrievalMigrationJournalRow[]
  runtime: {
    killSwitchEngaged: boolean
    changedAt?: number
    changedBy?: "user" | "migration" | "safety"
    reasonCode?: string
  }
}

function matchesCorpusScope(
  corpusId: string,
  input: { corpusIds?: readonly string[]; corpusPrefixes?: readonly string[] }
): boolean {
  const corpusIds = input.corpusIds ?? []
  const corpusPrefixes = input.corpusPrefixes ?? []
  if (corpusIds.length === 0 && corpusPrefixes.length === 0) return true
  return (
    corpusIds.includes(corpusId) || corpusPrefixes.some((prefix) => corpusId.startsWith(prefix))
  )
}

export async function listRetrievalControlSnapshot(
  input: {
    corpusIds?: readonly string[]
    corpusPrefixes?: readonly string[]
  } = {}
): Promise<RetrievalControlSnapshot> {
  const db = getDb()
  const [generations, jobs, traces, tombstones, migrations, runtime] = await Promise.all([
    db.retrievalGenerations.toArray(),
    db.retrievalJobs.toArray(),
    db.retrievalTraces.toArray(),
    db.retrievalTombstones.toArray(),
    db.retrievalMigrationJournal.toArray(),
    db.retrievalRuntimeState.get("global"),
  ])
  return {
    generations: generations
      .filter((row) => matchesCorpusScope(row.corpusId, input))
      .sort((left, right) => right.createdAt - left.createdAt),
    jobs: jobs
      .filter((row) => matchesCorpusScope(row.corpusId, input))
      .sort((left, right) => right.queuedAt - left.queuedAt),
    traces: traces
      .filter((row) => matchesCorpusScope(row.corpusId, input))
      .sort((left, right) => right.createdAt - left.createdAt),
    tombstones: tombstones
      .filter((row) => matchesCorpusScope(row.corpusId, input))
      .sort((left, right) => right.createdAt - left.createdAt),
    migrations: migrations.sort((left, right) => right.updatedAt - left.updatedAt),
    runtime: runtime
      ? {
          killSwitchEngaged: runtime.killSwitchEngaged,
          changedAt: runtime.changedAt,
          changedBy: runtime.changedBy,
          reasonCode: runtime.reasonCode,
        }
      : { killSwitchEngaged: false },
  }
}

export async function claimNextRetrievalJob(
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = 60_000
): Promise<RetrievalJobRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.retrievalJobs, async () => {
    const candidates = await Promise.all(
      ACTIVE_JOB_STATUSES.map((status) =>
        db.retrievalJobs.where("status").equals(status).sortBy("queuedAt")
      )
    )
    const next = candidates
      .flat()
      .filter((job) => canClaimRetrievalJob(job, now))
      .sort((left, right) => left.queuedAt - right.queuedAt)[0]
    if (!next) return undefined
    const claimed = claimRetrievalJob(next, workerId, now, leaseTtlMs)
    await db.retrievalJobs.put(claimed)
    return claimed
  })
}

export async function heartbeatStoredRetrievalJob(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = 60_000
): Promise<RetrievalJobRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalJobs, async () => {
    const job = await db.retrievalJobs.get(id)
    if (!job) throw new Error("Retrieval job not found")
    const heartbeat = heartbeatRetrievalJob(job, workerId, now, leaseTtlMs)
    await db.retrievalJobs.put(heartbeat)
    return heartbeat
  })
}

export async function finishRetrievalJob(
  id: string,
  status: Exclude<RetrievalJobStatus, "queued" | "running">,
  options: { resultCode: string; nextAttemptAt?: number; now?: number }
): Promise<RetrievalJobRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalJobs, async () => {
    const job = await db.retrievalJobs.get(id)
    if (!job) throw new Error("Retrieval job not found")
    const next = transitionRetrievalJob(job, status, options.now ?? Date.now(), {
      resultCode: options.resultCode,
      nextAttemptAt: options.nextAttemptAt,
    })
    await db.retrievalJobs.put(next)
    return next
  })
}

export async function storeRetrievalEncryptedContent(
  row: RetrievalEncryptedContentRow
): Promise<void> {
  if (row.envelope.ciphertext.length === 0) throw new Error("Encrypted content is required")
  await getDb().retrievalEncryptedContent.put(row)
}

export async function appendRetrievalTrace(row: RetrievalTraceRow): Promise<void> {
  const serialized = JSON.stringify(row)
  if (/"(?:query|content|text|path|userId)"\s*:/.test(serialized)) {
    throw new Error("Retrieval trace contains a forbidden content-bearing field")
  }
  await getDb().retrievalTraces.put(row)
}

export async function deleteRetrievalEntity(input: {
  entityType: string
  entityId: string
  corpusId: string
  knownDeviceIds: string[]
  now?: number
}): Promise<RetrievalTombstoneRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const id = `${input.entityType}:${input.entityId}`
  return db.transaction("rw", [db.retrievalEncryptedContent, db.retrievalTombstones], async () => {
    await db.retrievalEncryptedContent
      .where("[entityType+entityId]")
      .equals([input.entityType, input.entityId])
      .delete()
    const tombstone: RetrievalTombstoneRow = {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      corpusId: input.corpusId,
      createdAt: now,
      acknowledgedDeviceIds: [],
      pendingDeviceIds: [...new Set(input.knownDeviceIds)].sort(),
      ...(input.knownDeviceIds.length === 0
        ? { eligiblePurgeAt: now + 30 * 24 * 60 * 60 * 1000 }
        : {}),
    }
    await db.retrievalTombstones.put(tombstone)
    return tombstone
  })
}

export async function acknowledgeRetrievalTombstone(
  id: string,
  deviceId: string,
  now: number = Date.now()
): Promise<RetrievalTombstoneRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalTombstones, async () => {
    const row = await db.retrievalTombstones.get(id)
    if (!row) throw new Error("Retrieval tombstone not found")
    const pendingDeviceIds = row.pendingDeviceIds.filter((candidate) => candidate !== deviceId)
    const acknowledgedDeviceIds = [...new Set([...row.acknowledgedDeviceIds, deviceId])].sort()
    const next: RetrievalTombstoneRow = {
      ...row,
      pendingDeviceIds,
      acknowledgedDeviceIds,
      ...(pendingDeviceIds.length === 0 && row.eligiblePurgeAt === undefined
        ? { eligiblePurgeAt: now + 30 * 24 * 60 * 60 * 1000 }
        : {}),
    }
    await db.retrievalTombstones.put(next)
    return next
  })
}

export async function startRetrievalMigrationPhase(
  input: Pick<RetrievalMigrationJournalRow, "id" | "phase"> & { now?: number }
): Promise<RetrievalMigrationJournalRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.retrievalMigrationJournal, async () => {
    const existing = await db.retrievalMigrationJournal.get(input.id)
    if (existing?.status === "succeeded") return existing
    const row: RetrievalMigrationJournalRow = {
      id: input.id,
      phase: input.phase,
      status: "running",
      watermark: existing?.watermark,
      processedCount: existing?.processedCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await db.retrievalMigrationJournal.put(row)
    return row
  })
}

export async function checkpointRetrievalMigration(input: {
  id: string
  watermark: string
  processedDelta: number
  now?: number
}): Promise<RetrievalMigrationJournalRow> {
  if (!input.watermark || !Number.isInteger(input.processedDelta) || input.processedDelta < 0) {
    throw new Error("A migration watermark and non-negative processed delta are required")
  }
  const db = getDb()
  return db.transaction("rw", db.retrievalMigrationJournal, async () => {
    const row = await db.retrievalMigrationJournal.get(input.id)
    if (!row || row.status !== "running") throw new Error("Migration phase is not running")
    const next: RetrievalMigrationJournalRow = {
      ...row,
      watermark: input.watermark,
      processedCount: row.processedCount + input.processedDelta,
      updatedAt: input.now ?? Date.now(),
    }
    await db.retrievalMigrationJournal.put(next)
    return next
  })
}

export async function finishRetrievalMigrationPhase(input: {
  id: string
  status: "succeeded" | "failed"
  failureCode?: string
  now?: number
}): Promise<RetrievalMigrationJournalRow> {
  const db = getDb()
  return db.transaction("rw", db.retrievalMigrationJournal, async () => {
    const row = await db.retrievalMigrationJournal.get(input.id)
    if (!row || row.status !== "running") throw new Error("Migration phase is not running")
    if (input.status === "failed" && !input.failureCode) {
      throw new Error("Failed migration phases require a bounded failure code")
    }
    const next: RetrievalMigrationJournalRow = {
      ...row,
      status: input.status,
      failureCode: input.status === "failed" ? input.failureCode : undefined,
      updatedAt: input.now ?? Date.now(),
    }
    await db.retrievalMigrationJournal.put(next)
    return next
  })
}

export interface RetrievalReconcileReport {
  corpusId: string
  activeGenerationId?: string
  pointerRepaired: boolean
  remoteWithoutLocalIds: string[]
  localWithoutRemoteIds: string[]
  countMismatch: boolean
}

export async function reconcileRetrievalCorpus(input: {
  corpusId: string
  localVectorIds: readonly string[]
  remoteVectorIds: readonly string[]
  now?: number
}): Promise<RetrievalReconcileReport> {
  const db = getDb()
  const now = input.now ?? Date.now()
  let pointerRepaired = false
  let active = await getActiveRetrievalGeneration(input.corpusId)
  if (!active || active.status !== "active") {
    const candidates = await db.retrievalGenerations
      .where("[corpusId+status]")
      .equals([input.corpusId, "active"])
      .toArray()
    active = candidates.sort(
      (left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
    )[0]
    if (active) {
      await db.retrievalActivePointers.put({
        corpusId: input.corpusId,
        generationId: active.id,
        domain: active.domain,
        profileFingerprint: active.profileFingerprint,
        updatedAt: now,
      })
    } else {
      await db.retrievalActivePointers.delete(input.corpusId)
    }
    pointerRepaired = true
  }

  const local = new Set(input.localVectorIds)
  const remote = new Set(input.remoteVectorIds)
  const remoteWithoutLocalIds = [...remote].filter((id) => !local.has(id)).sort()
  const localWithoutRemoteIds = [...local].filter((id) => !remote.has(id)).sort()
  return {
    corpusId: input.corpusId,
    activeGenerationId: active?.id,
    pointerRepaired,
    remoteWithoutLocalIds,
    localWithoutRemoteIds,
    countMismatch:
      active?.validation?.count !== undefined && active.validation.count !== local.size,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const SHORT_RETENTION_STATUSES: RetrievalJobStatus[] = ["succeeded", "no_output"]

export async function pruneRetrievalControlData(
  now: number = Date.now(),
  caps: { jobs?: number; traces?: number } = {}
): Promise<{ jobsDeleted: number; tracesDeleted: number }> {
  const db = getDb()
  return db.transaction("rw", [db.retrievalJobs, db.retrievalTraces], async () => {
    const jobs = await db.retrievalJobs.toArray()
    const jobsToDelete = new Set(
      jobs
        .filter((job) => {
          const completedAt = job.completedAt ?? job.queuedAt
          const retention = SHORT_RETENTION_STATUSES.includes(job.status) ? 30 : 90
          return completedAt < now - retention * DAY_MS
        })
        .map((job) => job.id)
    )
    const retainedCompleted = jobs
      .filter((job) => SHORT_RETENTION_STATUSES.includes(job.status) && !jobsToDelete.has(job.id))
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
    for (const job of retainedCompleted.slice(caps.jobs ?? 20_000)) jobsToDelete.add(job.id)

    const traces = await db.retrievalTraces.orderBy("createdAt").reverse().toArray()
    const traceIds = traces
      .filter((trace, index) => trace.expiresAt <= now || index >= (caps.traces ?? 20_000))
      .map((trace) => trace.traceId)
    await db.retrievalJobs.bulkDelete([...jobsToDelete])
    await db.retrievalTraces.bulkDelete(traceIds)
    return { jobsDeleted: jobsToDelete.size, tracesDeleted: traceIds.length }
  })
}

export type RetrievalOperation =
  "kernel" | "ingest" | "promotion" | "decrypt" | "export" | "delete" | "reconcile" | "lexical_read"

const KILL_SWITCH_ALLOWED = new Set<RetrievalOperation>([
  "decrypt",
  "export",
  "delete",
  "reconcile",
  "lexical_read",
])

export async function setRetrievalKillSwitch(input: {
  engaged: boolean
  changedBy: "user" | "migration" | "safety"
  reasonCode?: string
  now?: number
}): Promise<void> {
  if (input.engaged && !input.reasonCode) {
    throw new Error("Engaging the retrieval kill switch requires a bounded reason code")
  }
  await getDb().retrievalRuntimeState.put({
    id: "global",
    killSwitchEngaged: input.engaged,
    changedAt: input.now ?? Date.now(),
    changedBy: input.changedBy,
    reasonCode: input.engaged ? input.reasonCode : undefined,
  })
}

export async function isRetrievalKillSwitchEngaged(): Promise<boolean> {
  return (await getDb().retrievalRuntimeState.get("global"))?.killSwitchEngaged ?? false
}

export async function assertRetrievalOperationAllowed(
  operation: RetrievalOperation
): Promise<void> {
  if ((await isRetrievalKillSwitchEngaged()) && !KILL_SWITCH_ALLOWED.has(operation)) {
    const error = new Error(`Retrieval ${operation} is disabled by the rollout kill switch`)
    error.name = "RetrievalKillSwitchError"
    throw error
  }
}
