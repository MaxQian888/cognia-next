// Dexie access for Notification V2 projection work rows (v227).
//
// The durable dirty-marker the Run Journal touches inside its own commit.
// `desired*` is the journal's "this much must be projected"; `processed*` is
// what the projector has consumed. The reconciler sweeps `state != "done"`
// rows even when the in-process wake is lost — wake is a hint, never the
// reliability mechanism.
//
// Two writers, deliberately different:
//   • `touchNotificationProjectionInTransaction` — the journal's commit-time
//     touch: raises `desired*`, creates the row if absent. Called INSIDE the
//     outer transaction that appends the run event, so work and event are
//     atomic.
//   • `claimProjectionWork` / `commitProjectionCursor` — the projector's
//     lease + cursor advance, each its own short transaction.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { NotificationProjectionWork } from "@/types/notifications/delivery"

export type { NotificationProjectionWork }

const LEASE_MS = 30_000

/** The subject key a run-scoped work row is addressed by. */
export function runSubjectKey(runId: string): string {
  return `run:${runId}`
}

/**
 * The journal-commit touch. Runs inside the SAME Dexie transaction that
 * appends the run event — pass the transaction-bound `db` (a `CogniaDB`
 * transaction proxy), never `getDb()`. Creates the work row on first touch;
 * thereafter only raises `desired*` / re-opens a `done` row.
 *
 * `generation` is bumped externally (policy change, redaction upgrade) to
 * force reprojection of already-consumed events.
 */
export async function touchNotificationProjectionInTransaction(
  db: CogniaDB,
  input: {
    runId: string
    scopeKey: string
    /** Highest committed run-event seq for this run. */
    desiredRunSeq: number
    /** Latest committed result-summary revision, when the event carried one. */
    desiredResultRevision?: number
    /** The host epoch this work is owned under — stale-epoch guard. */
    ownerEpoch?: number
  }
): Promise<void> {
  const now = Date.now()
  const subjectKey = runSubjectKey(input.runId)
  const existing = await db.notificationProjectionWork
    .where("subjectKey")
    .equals(subjectKey)
    .first()
  if (!existing) {
    const row: NotificationProjectionWork = {
      id: nanoid(),
      scopeKey: input.scopeKey,
      subjectKey,
      runId: input.runId,
      desiredRunSeq: input.desiredRunSeq,
      processedRunSeq: 0,
      desiredResultRevision: input.desiredResultRevision ?? 0,
      processedResultRevision: 0,
      generation: 0,
      state: "pending",
      retryCount: 0,
      ...(input.ownerEpoch !== undefined ? { ownerEpoch: input.ownerEpoch } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await db.notificationProjectionWork.put(row)
    return
  }
  // Re-open only when there's genuinely new work; a `done` row with no new
  // desired state stays done (a no-op touch must not resurrect it).
  const hasNewWork =
    input.desiredRunSeq > existing.processedRunSeq ||
    (input.desiredResultRevision ?? existing.desiredResultRevision) >
      existing.processedResultRevision
  const nextDesiredSeq = Math.max(existing.desiredRunSeq, input.desiredRunSeq)
  const nextDesiredResult = Math.max(
    existing.desiredResultRevision,
    input.desiredResultRevision ?? existing.desiredResultRevision
  )
  await db.notificationProjectionWork.put({
    ...existing,
    desiredRunSeq: nextDesiredSeq,
    desiredResultRevision: nextDesiredResult,
    state: hasNewWork && existing.state === "done" ? "pending" : existing.state,
    ...(input.ownerEpoch !== undefined ? { ownerEpoch: input.ownerEpoch } : {}),
    updatedAt: now,
  })
}

/**
 * Claim one pending work row for `leaseOwner`. Short transaction: reads the
 * row, verifies it still has unprocessed work and no live lease, stamps the
 * lease, returns the claimed row. Returns `undefined` when nothing is
 * claimable (all leased / done / not yet due).
 */
export async function claimProjectionWork(
  subjectKey: string,
  leaseOwner: string,
  now = Date.now()
): Promise<NotificationProjectionWork | undefined> {
  const db = getDb()
  return db.transaction("rw", db.notificationProjectionWork, async () => {
    const row = await db.notificationProjectionWork.where("subjectKey").equals(subjectKey).first()
    if (!row) return undefined
    const leased = row.leaseExpiresAt !== undefined && row.leaseExpiresAt > now
    if (leased && row.leaseOwner !== leaseOwner) return undefined
    const hasWork =
      row.desiredRunSeq > row.processedRunSeq ||
      row.desiredResultRevision > row.processedResultRevision
    if (!hasWork && row.state === "done") return undefined
    if (row.state === "blocked" && row.retryAt !== undefined && row.retryAt > now) return undefined
    const claimed: NotificationProjectionWork = {
      ...row,
      state: "processing",
      leaseOwner,
      leaseExpiresAt: now + LEASE_MS,
      updatedAt: now,
    }
    await db.notificationProjectionWork.put(claimed)
    return claimed
  })
}

/**
 * The projector's commit — advances `processed*` ONLY across the contiguous
 * successful cursor it was given, inside one transaction. The `generation`
 * and the row's identity are CAS-checked; a bumped generation or a different
 * desired state means the plan was built on stale inputs and must replan.
 *
 * Returns the post-commit row, or `undefined` on a CAS failure (caller
 * rereads and replans).
 */
export async function commitProjectionCursor(
  subjectKey: string,
  expected: {
    generation: number
    leaseOwner: string
    /** The contiguous seq the projector consumed up to. */
    processedRunSeq: number
    processedResultRevision: number
  }
): Promise<NotificationProjectionWork | undefined> {
  const db = getDb()
  const now = Date.now()
  return db.transaction("rw", db.notificationProjectionWork, async () => {
    const row = await db.notificationProjectionWork.where("subjectKey").equals(subjectKey).first()
    if (!row) return undefined
    if (row.generation !== expected.generation) return undefined
    if (row.leaseOwner !== expected.leaseOwner) return undefined
    // Never regress the cursor, and never advance past what the journal says
    // is committed — the projector can only consume contiguous, existing work.
    const processedRunSeq = Math.max(row.processedRunSeq, expected.processedRunSeq)
    const processedResultRevision = Math.max(
      row.processedResultRevision,
      expected.processedResultRevision
    )
    const caughtUp =
      processedRunSeq >= row.desiredRunSeq && processedResultRevision >= row.desiredResultRevision
    const next: NotificationProjectionWork = {
      ...row,
      processedRunSeq,
      processedResultRevision,
      // `done` only when the cursor truly caught the journal; new events that
      // arrived DURING processing leave `desired > processed` → stays pending.
      state: caughtUp ? "done" : "pending",
      retryCount: 0,
      retryAt: undefined,
      lastErrorCode: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    }
    await db.notificationProjectionWork.put(next)
    return next
  })
}

/**
 * Transaction-bound cursor advance — the projector's per-event commit step.
 * Runs inside the caller's transaction (the same one that writes the event's
 * delivery intents), so the "we consumed up to seq N" fact and the sends it
 * produced are atomic — a crash can't lose one half. CAS-checks generation +
 * lease. Returns `false` on a CAS failure (caller must replan).
 */
export async function commitProjectionCursorInsideTransaction(
  txDb: CogniaDB,
  subjectKey: string,
  expected: {
    generation: number
    leaseOwner: string
    processedRunSeq: number
    processedResultRevision: number
  }
): Promise<boolean> {
  const now = Date.now()
  const row = await txDb.notificationProjectionWork.where("subjectKey").equals(subjectKey).first()
  if (!row) return false
  if (row.generation !== expected.generation) return false
  if (row.leaseOwner !== expected.leaseOwner) return false
  const processedRunSeq = Math.max(row.processedRunSeq, expected.processedRunSeq)
  const processedResultRevision = Math.max(
    row.processedResultRevision,
    expected.processedResultRevision
  )
  const caughtUp =
    processedRunSeq >= row.desiredRunSeq && processedResultRevision >= row.desiredResultRevision
  await txDb.notificationProjectionWork.put({
    ...row,
    processedRunSeq,
    processedResultRevision,
    state: caughtUp ? "done" : "pending",
    retryCount: 0,
    retryAt: undefined,
    nextAttemptAt: undefined,
    lastErrorCode: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  })
  return true
}

/** Mark a claimed row blocked with a retry backoff + a terminal error code. */
export async function blockProjectionWork(
  subjectKey: string,
  leaseOwner: string,
  errorCode: string,
  retryAt: number
): Promise<void> {
  const db = getDb()
  const now = Date.now()
  await db.transaction("rw", db.notificationProjectionWork, async () => {
    const row = await db.notificationProjectionWork.where("subjectKey").equals(subjectKey).first()
    if (!row || row.leaseOwner !== leaseOwner) return
    await db.notificationProjectionWork.put({
      ...row,
      state: "blocked",
      retryCount: row.retryCount + 1,
      retryAt,
      nextAttemptAt: retryAt,
      lastErrorCode: errorCode,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
  })
}

/**
 * The reconciler's sweep — every row that still has unprocessed work and is
 * either unclaimed, lease-expired, or due for retry. This is the compensatory
 * mechanism that survives a lost wake / a crashed projector.
 */
export async function listDueProjectionWork(
  now = Date.now()
): Promise<NotificationProjectionWork[]> {
  const db = getDb()
  return db.notificationProjectionWork
    .filter((row) => {
      const hasWork =
        row.desiredRunSeq > row.processedRunSeq ||
        row.desiredResultRevision > row.processedResultRevision
      if (!hasWork) return false
      const leased = row.leaseExpiresAt !== undefined && row.leaseExpiresAt > now
      if (leased) return false
      if (row.state === "blocked" && row.retryAt !== undefined && row.retryAt > now) return false
      return true
    })
    .toArray()
}

/** Bump `generation` on every work row in a scope — forces reprojection. */
export async function bumpProjectionGeneration(scopeKey: string): Promise<number> {
  const db = getDb()
  const now = Date.now()
  let bumped = 0
  await db.transaction("rw", db.notificationProjectionWork, async () => {
    const rows = await db.notificationProjectionWork.where("scopeKey").equals(scopeKey).toArray()
    for (const row of rows) {
      await db.notificationProjectionWork.put({
        ...row,
        generation: row.generation + 1,
        // A bumped generation re-opens even a `done` row — the policy changed.
        state: "pending",
        updatedAt: now,
      })
      bumped += 1
    }
  })
  return bumped
}
