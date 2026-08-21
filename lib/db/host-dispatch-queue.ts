import { getDb } from "@/lib/db/schema"
import type {
  HostDispatchDomain,
  HostDispatchJobRow,
  HostDispatchStatus,
} from "@/types/placement/host-dispatch"

/**
 * Accessors for the durable host → target dispatch queue (Dexie v175).
 *
 * Semantics mirror `lib/db/mobile-outbound-queue.ts` on purpose — same
 * enqueue-once idempotency key, same exponential backoff, same explicit
 * dead-letter — because those are correct and two dialects of the same queue
 * drift. What differs is only the direction and the addressing.
 */

const DEFAULT_MAX_ATTEMPTS = 6
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 5 * 60_000

export interface EnqueueHostDispatchInput {
  accountId: string
  domain: HostDispatchDomain
  targetRef: string
  kind: string
  payload: Record<string, unknown>
  /** Minted by the caller so a retry of the *caller* reuses one row. */
  idempotencyKey: string
  runId?: string
  stepId?: string
  label?: string
  maxAttempts?: number
  now?: number
  id?: string
}

/**
 * Exponential backoff with a ceiling.
 *
 * Deliberately deterministic: two hosts must not need to agree on a delay, and
 * a test that cannot predict the next attempt time cannot assert on it. Jitter
 * belongs to the runner's scheduling, not to the row.
 */
export function hostDispatchBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent)
}

/**
 * Enqueue, or return the row that already owns this idempotency key.
 *
 * The key is the identity of the *work*, not of the attempt, so a caller that
 * retries after a crash re-finds its row instead of dispatching twice.
 */
export async function enqueueHostDispatch(
  input: EnqueueHostDispatchInput
): Promise<HostDispatchJobRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const existing = await db.hostDispatchQueue
    .where("idempotencyKey")
    .equals(input.idempotencyKey)
    .first()
  if (existing) return existing

  const row: HostDispatchJobRow = {
    id: input.id ?? crypto.randomUUID(),
    accountId: input.accountId,
    domain: input.domain,
    targetRef: input.targetRef,
    kind: input.kind,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    idempotencyKey: input.idempotencyKey,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.label ? { label: input.label } : {}),
  }
  try {
    await db.hostDispatchQueue.add(row)
    return row
  } catch {
    // A concurrent enqueue with the same key won the unique-index race. Its
    // row is the one that exists, and returning ours would dispatch the work
    // twice — the read above cannot prevent this on its own, which is why the
    // index carries the constraint.
    const winner = await db.hostDispatchQueue
      .where("idempotencyKey")
      .equals(input.idempotencyKey)
      .first()
    return winner ?? row
  }
}

/** Rows due for an attempt, oldest first. */
export async function claimDueHostDispatch(
  accountId: string,
  now: number = Date.now(),
  limit = 20
): Promise<HostDispatchJobRow[]> {
  const due = await getDb()
    .hostDispatchQueue.where("[status+nextAttemptAt]")
    .between(["pending", 0], ["pending", now], true, true)
    .toArray()
  return due
    .filter((row) => row.accountId === accountId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, limit)
}

/** Mark a row in flight so a second runner in the same process skips it. */
export async function markHostDispatchInflight(id: string, now = Date.now()): Promise<void> {
  await getDb().hostDispatchQueue.update(id, { status: "inflight", updatedAt: now })
}

export async function completeHostDispatch(id: string, now = Date.now()): Promise<void> {
  await getDb().hostDispatchQueue.update(id, { status: "succeeded", updatedAt: now })
}

/**
 * Record a failure and decide whether it gets another attempt.
 *
 * Dead-lettering is explicit rather than a silent drop: a dispatch that has
 * genuinely run out of road is something a human has to see, and an
 * indefinitely retrying row is how a queue quietly becomes a busy loop.
 */
export async function failHostDispatch(
  id: string,
  error: string,
  now = Date.now()
): Promise<HostDispatchStatus> {
  const db = getDb()
  const row = await db.hostDispatchQueue.get(id)
  if (!row) return "failed"
  const attempts = row.attempts + 1
  const exhausted = attempts >= row.maxAttempts
  const status: HostDispatchStatus = exhausted ? "deadletter" : "pending"
  await db.hostDispatchQueue.update(id, {
    status,
    attempts,
    lastError: error,
    updatedAt: now,
    nextAttemptAt: exhausted ? row.nextAttemptAt : now + hostDispatchBackoffMs(attempts),
  })
  return status
}

/**
 * Return rows stranded `inflight` by a host that died mid-dispatch.
 *
 * Without this an interrupted dispatch stays `inflight` forever and is never
 * retried — the exact silent loss this queue exists to prevent.
 */
export async function recoverStrandedHostDispatch(
  accountId: string,
  now = Date.now()
): Promise<number> {
  const db = getDb()
  const stranded = await db.hostDispatchQueue
    .where("[accountId+status]")
    .equals([accountId, "inflight"])
    .toArray()
  if (stranded.length === 0) return 0
  await db.hostDispatchQueue.bulkPut(
    stranded.map((row) => ({
      ...row,
      status: "pending" as const,
      updatedAt: now,
      nextAttemptAt: now,
    }))
  )
  return stranded.length
}

export async function listHostDispatchForRun(runId: string): Promise<HostDispatchJobRow[]> {
  return getDb().hostDispatchQueue.where("runId").equals(runId).toArray()
}

export async function listDeadLetteredHostDispatch(
  accountId: string
): Promise<HostDispatchJobRow[]> {
  return getDb()
    .hostDispatchQueue.where("[accountId+status]")
    .equals([accountId, "deadletter"])
    .toArray()
}
