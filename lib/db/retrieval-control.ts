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
