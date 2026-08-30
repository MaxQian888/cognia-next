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

/**
 * Record a re-check verdict on one evidence row.
 *
 * Narrow by design: the sweep may write only what it learned. Widening this to
 * a general patch would let a re-check silently rewrite `sourceId`, `messageId`
 * or `excerptHash` — the very fields the NEXT re-check compares against, which
 * would make the check self-confirming.
 */
export async function recordMemoryEvidenceVerdict(
  id: string,
  verdict: {
    validationState: MemoryEvidence["validationState"]
    validatedAt?: number
    validationStrategy?: MemoryEvidence["validationStrategy"]
  }
): Promise<void> {
  await getDb().memoryEvidence.update(id, {
    validationState: verdict.validationState,
    validatedAt: verdict.validatedAt ?? Date.now(),
    ...(verdict.validationStrategy ? { validationStrategy: verdict.validationStrategy } : {}),
  })
}

/**
 * Mark every evidence row that cites one of `messageIds` as `revoked`.
 *
 * The source of truth for "which claims depended on this message" is the
 * `messageId` index — this is what it exists for. Returns the affected memory
 * ids so the caller can queue a re-check for each.
 */
export async function revokeMemoryEvidenceForMessages(
  messageIds: readonly string[],
  now: number = Date.now()
): Promise<string[]> {
  if (messageIds.length === 0) return []
  const db = getDb()
  const rows = await db.memoryEvidence
    .where("messageId")
    .anyOf([...messageIds])
    .toArray()
  if (rows.length === 0) return []
  await db.memoryEvidence.bulkPut(
    rows.map((row) => ({ ...row, validationState: "revoked" as const, validatedAt: now }))
  )
  return [...new Set(rows.map((row) => row.memoryId).filter((id): id is string => Boolean(id)))]
}

/**
 * Mark every evidence row captured in one session as `revoked`.
 *
 * Used when a whole session goes: `sessionId` is indexed, and unlike a
 * message-id sweep this also catches rows that carry no `messageId` at all —
 * the turn-level citations `runTurnMemory` writes. Returns the affected memory
 * ids.
 */
export async function revokeMemoryEvidenceForSession(
  sessionId: string,
  now: number = Date.now()
): Promise<string[]> {
  if (!sessionId) return []
  const db = getDb()
  const rows = await db.memoryEvidence.where("sessionId").equals(sessionId).toArray()
  if (rows.length === 0) return []
  await db.memoryEvidence.bulkPut(
    rows.map((row) => ({ ...row, validationState: "revoked" as const, validatedAt: now }))
  )
  return [...new Set(rows.map((row) => row.memoryId).filter((id): id is string => Boolean(id)))]
}

/**
 * Cancel every still-pending job for a session.
 *
 * A job whose session is gone would fail `loadJobContext` with a terminal
 * `session_unavailable` anyway, so this is about the console rather than
 * correctness: without it, deleting a busy conversation leaves a row of jobs
 * that look like real pending work and then die one by one.
 */
export async function cancelMemoryJobsForSession(sessionId: string): Promise<number> {
  if (!sessionId) return 0
  const db = getDb()
  const pending = await db.memoryJobs.where("sessionId").equals(sessionId).toArray()
  let cancelled = 0
  for (const job of pending) {
    if (job.status !== "queued" && job.status !== "running" && job.status !== "retry_wait") continue
    await cancelMemoryJob(job.id)
    cancelled += 1
  }
  return cancelled
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

export async function bindMemoryGovernanceOutcome(input: {
  memoryId: string
  patch: Partial<
    Pick<
      import("@/types/memory/memory").Memory,
      "evidenceState" | "reviewStatus" | "contaminationState" | "sensitivity"
    >
  >
  evidence: MemoryEvidenceDraft
  audit: MemoryAuditEventDraft
  now?: number
}): Promise<{ evidence: MemoryEvidence; audit: MemoryAuditEvent }> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", [db.memories, db.memoryEvidence, db.memoryAuditEvents], async () => {
    if (!(await db.memories.get(input.memoryId))) throw new Error("Memory not found")
    const evidence: MemoryEvidence = {
      ...input.evidence,
      memoryId: input.memoryId,
      id: input.evidence.id ?? newId("mev"),
      createdAt: input.evidence.createdAt ?? now,
    }
    const audit: MemoryAuditEvent = {
      ...input.audit,
      memoryId: input.memoryId,
      id: input.audit.id ?? newId("mau"),
      createdAt: input.audit.createdAt ?? now,
    }
    await db.memories.update(input.memoryId, { ...input.patch, updatedAt: now })
    await db.memoryEvidence.add(evidence)
    await db.memoryAuditEvents.add(audit)
    return { evidence, audit }
  })
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
  Partial<Pick<MemoryJob, "id" | "status" | "queuedAt" | "retryCount" | "attempt" | "maxAttempts">>

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
        .filter((job) => job.status === "succeeded" || job.status === "no_output")
        .sort((a, b) => b.queuedAt - a.queuedAt)[0]
      if (completed) return completed
    }

    const row: MemoryJob = {
      ...draft,
      id: draft.id ?? newId("mjob"),
      status: draft.status ?? "queued",
      queuedAt: draft.queuedAt ?? Date.now(),
      retryCount: draft.retryCount ?? 0,
      attempt: draft.attempt ?? 0,
      maxAttempts: draft.maxAttempts ?? 4,
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
        (job.status === "retry_wait" && (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now) ||
        (job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now))
    if (!job || !claimable) return undefined
    const claimed: MemoryJob = {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? now,
      heartbeatAt: now,
      attempt: (job.attempt ?? 0) + 1,
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
    // `[status+queuedAt]` keeps the scan ordered by claim priority. `first()`
    // stops as soon as it reaches an eligible row, rather than materializing
    // every queued/running job and sorting both arrays in renderer memory.
    const [queued, retryWait, expiredLease] = await Promise.all([
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["queued", 0], ["queued", Number.MAX_SAFE_INTEGER])
        .filter((job) => (job.nextAttemptAt ?? 0) <= now)
        .first(),
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["retry_wait", 0], ["retry_wait", Number.MAX_SAFE_INTEGER])
        .filter((job) => (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now)
        .first(),
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["running", 0], ["running", Number.MAX_SAFE_INTEGER])
        .filter((job) => job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now)
        .first(),
    ])
    const next = [queued, retryWait, expiredLease]
      .filter((job): job is MemoryJob => job !== undefined)
      .sort((left, right) => left.queuedAt - right.queuedAt)[0]
    if (!next) return undefined

    const claimed: MemoryJob = {
      ...next,
      status: "running",
      startedAt: next.startedAt ?? now,
      heartbeatAt: now,
      attempt: (next.attempt ?? 0) + 1,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      nextAttemptAt: undefined,
      errorCode: undefined,
    }
    await db.memoryJobs.put(claimed)
    return claimed
  })
}

export async function finishMemoryJob(
  id: string,
  status: "succeeded" | "no_output" | "skipped" | "failed" | "cancelled",
  resultCode: string,
  now: number = Date.now()
): Promise<void> {
  await getDb().memoryJobs.update(id, {
    status,
    completedAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    heartbeatAt: undefined,
    errorCode: undefined,
    resultCode,
  })
}

/** Compatibility wrapper for existing callers; success is now explicit. */
export async function completeMemoryJob(id: string, now: number = Date.now()): Promise<void> {
  return finishMemoryJob(id, "succeeded", "completed", now)
}

export async function heartbeatMemoryJob(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = 10 * 60 * 1000
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    if (
      !job ||
      job.status !== "running" ||
      job.leaseOwner !== workerId ||
      (job.leaseExpiresAt ?? 0) < now
    ) {
      return undefined
    }
    const heartbeat = { ...job, heartbeatAt: now, leaseExpiresAt: now + leaseTtlMs }
    await db.memoryJobs.put(heartbeat)
    return heartbeat
  })
}

export async function cancelMemoryJob(
  id: string,
  now: number = Date.now()
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    if (!job || ["succeeded", "no_output", "skipped", "failed", "cancelled"].includes(job.status)) {
      return job
    }
    const cancelled: MemoryJob = {
      ...job,
      status: "cancelled",
      cancellationRequestedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      resultCode: "cancelled_by_user",
    }
    await db.memoryJobs.put(cancelled)
    return cancelled
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
      status: "retry_wait",
      retryCount,
      nextAttemptAt: now + baseDelayMs * 2 ** (retryCount - 1),
      errorCode,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      resultCode: "retry_scheduled",
    })
    return "retry_wait"
  }

  await db.memoryJobs.update(id, {
    status: "failed",
    retryCount,
    completedAt: now,
    errorCode,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    heartbeatAt: undefined,
    resultCode: "retry_exhausted",
  })
  return "failed"
}

export async function pruneMemoryGovernanceData(
  now: number = Date.now(),
  cap = 20_000
): Promise<{ jobsDeleted: number; auditsDeleted: number }> {
  const db = getDb()
  const dayMs = 24 * 60 * 60 * 1000
  return db.transaction("rw", [db.memoryJobs, db.memoryAuditEvents], async () => {
    const jobs = await db.memoryJobs.toArray()
    const jobsToDelete = new Set(
      jobs
        .filter((job) => {
          const terminalAt = job.completedAt ?? job.queuedAt
          const shortRetention = job.status === "succeeded" || job.status === "no_output"
          return terminalAt < now - (shortRetention ? 30 : 90) * dayMs
        })
        .map((job) => job.id)
    )
    const successful = jobs
      .filter(
        (job) =>
          (job.status === "succeeded" || job.status === "no_output") && !jobsToDelete.has(job.id)
      )
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
    for (const job of successful.slice(cap)) jobsToDelete.add(job.id)
    const auditIds = (await db.memoryAuditEvents
      .where("createdAt")
      .below(now - 180 * dayMs)
      .primaryKeys()) as string[]
    await db.memoryJobs.bulkDelete([...jobsToDelete])
    await db.memoryAuditEvents.bulkDelete(auditIds)
    return { jobsDeleted: jobsToDelete.size, auditsDeleted: auditIds.length }
  })
}
