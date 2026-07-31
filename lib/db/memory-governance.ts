import type {
  MemoryAuditEvent,
  MemoryEvidence,
  MemoryJob,
  MemoryJobStatus,
} from "@/types/memory/governance"
import { getDb } from "./schema"

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export type MemoryEvidenceDraft = Omit<MemoryEvidence, "id" | "createdAt"> &
  Partial<Pick<MemoryEvidence, "id" | "createdAt">>

export async function createMemoryEvidence(draft: MemoryEvidenceDraft): Promise<MemoryEvidence> {
  const row: MemoryEvidence = {
    ...draft,
    id: draft.id ?? newId("mev"),
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().memoryEvidence.add(row)
  return row
}

export async function listMemoryEvidence(memoryId: string): Promise<MemoryEvidence[]> {
  return getDb().memoryEvidence.where("memoryId").equals(memoryId).sortBy("createdAt")
}

export async function deleteMemoryEvidence(memoryId: string): Promise<void> {
  await getDb().memoryEvidence.where("memoryId").equals(memoryId).delete()
}

export type MemoryAuditEventDraft = Omit<MemoryAuditEvent, "id" | "createdAt"> &
  Partial<Pick<MemoryAuditEvent, "id" | "createdAt">>

export async function appendMemoryAuditEvent(
  draft: MemoryAuditEventDraft
): Promise<MemoryAuditEvent> {
  const row: MemoryAuditEvent = {
    ...draft,
    id: draft.id ?? newId("mau"),
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().memoryAuditEvents.add(row)
  return row
}

export async function listMemoryAuditEvents(
  query: { memoryId?: string; sessionId?: string } = {}
): Promise<MemoryAuditEvent[]> {
  let collection = getDb().memoryAuditEvents.toCollection()
  if (query.memoryId) collection = collection.filter((event) => event.memoryId === query.memoryId)
  if (query.sessionId)
    collection = collection.filter((event) => event.sessionId === query.sessionId)
  return (await collection.toArray()).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Audit events newer than `cutoff`. Walks the `createdAt` index rather than
 * reading the whole (unbounded, never-pruned) table.
 */
export async function listMemoryAuditEventsSince(cutoff: number): Promise<MemoryAuditEvent[]> {
  return getDb().memoryAuditEvents.where("createdAt").above(cutoff).toArray()
}

/**
 * When decay/PII instrumentation started producing data, or `undefined` if it
 * never has. Used to decide whether a maintenance window can be reported
 * exactly or must fall back to the heuristic derived from `memories`.
 *
 * Walks the `createdAt` index in order and stops at the first match, so the
 * common case (instrumented data exists, and the earliest such event is old)
 * terminates almost immediately. The full-scan worst case is exactly the case
 * where the answer is "never instrumented" — and that scan stays on the index.
 */
export async function findEarliestInstrumentedAuditAt(
  reasons: readonly string[]
): Promise<number | undefined> {
  const match = new Set(reasons)
  const row = await getDb()
    .memoryAuditEvents.orderBy("createdAt")
    .filter((event) => match.has(event.reason))
    .first()
  return row?.createdAt
}

/** Every job row, newest-queued first. Completed rows are retained, not deleted. */
export async function listMemoryJobs(): Promise<MemoryJob[]> {
  return getDb().memoryJobs.orderBy("queuedAt").reverse().toArray()
}

export type MemoryJobDraft = Omit<MemoryJob, "id" | "status" | "queuedAt" | "retryCount"> &
  Partial<Pick<MemoryJob, "id" | "status" | "queuedAt" | "retryCount">>

export async function enqueueMemoryJob(
  draft: MemoryJobDraft,
  options: { reuseCompleted?: boolean } = {}
): Promise<MemoryJob> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const sameKey = await db.memoryJobs.where("dedupeKey").equals(draft.dedupeKey).toArray()
    const active = sameKey.find((job) => job.status === "queued" || job.status === "running")
    if (active) return active
    if (options.reuseCompleted) {
      const completed = sameKey
        .filter((job) => job.status === "completed")
        .sort((a, b) => b.queuedAt - a.queuedAt)[0]
      if (completed) return completed
    }

    const row: MemoryJob = {
      ...draft,
      id: draft.id ?? newId("mjob"),
      status: draft.status ?? "queued",
      queuedAt: draft.queuedAt ?? Date.now(),
      retryCount: draft.retryCount ?? 0,
    }
    await db.memoryJobs.add(row)
    return row
  })
}

export async function getMemoryJob(id: string): Promise<MemoryJob | undefined> {
  return getDb().memoryJobs.get(id)
}

export async function claimMemoryJob(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = 10 * 60 * 1000
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    const claimable =
      job &&
      ((job.status === "queued" && (job.nextAttemptAt ?? 0) <= now) ||
        (job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now))
    if (!job || !claimable) return undefined
    const claimed: MemoryJob = {
      ...job,
      status: "running",
      startedAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      nextAttemptAt: undefined,
      errorCode: undefined,
    }
    await db.memoryJobs.put(claimed)
    return claimed
  })
}

export async function claimNextMemoryJob(
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = 10 * 60 * 1000
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const [queued, running] = await Promise.all([
      db.memoryJobs.where("status").equals("queued").toArray(),
      db.memoryJobs.where("status").equals("running").toArray(),
    ])
    const eligible = [
      ...queued.filter((job) => (job.nextAttemptAt ?? 0) <= now),
      ...running.filter((job) => job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now),
    ].sort((a, b) => a.queuedAt - b.queuedAt)
    const next = eligible[0]
    if (!next) return undefined

    const claimed: MemoryJob = {
      ...next,
      status: "running",
      startedAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      nextAttemptAt: undefined,
      errorCode: undefined,
    }
    await db.memoryJobs.put(claimed)
    return claimed
  })
}

export async function completeMemoryJob(id: string, now: number = Date.now()): Promise<void> {
  await getDb().memoryJobs.update(id, {
    status: "completed",
    completedAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    errorCode: undefined,
  })
}

export async function failMemoryJob(
  id: string,
  errorCode: string,
  now: number = Date.now(),
  options: { maxRetries?: number; baseDelayMs?: number } = {}
): Promise<MemoryJobStatus> {
  const db = getDb()
  const job = await db.memoryJobs.get(id)
  if (!job) return "failed"
  const retryCount = job.retryCount + 1
  const maxRetries = options.maxRetries ?? 3
  if (retryCount <= maxRetries) {
    const baseDelayMs = options.baseDelayMs ?? 1_000
    await db.memoryJobs.update(id, {
      status: "queued",
      retryCount,
      nextAttemptAt: now + baseDelayMs * 2 ** (retryCount - 1),
      errorCode,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
    return "queued"
  }

  await db.memoryJobs.update(id, {
    status: "failed",
    retryCount,
    completedAt: now,
    errorCode,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  })
  return "failed"
}
