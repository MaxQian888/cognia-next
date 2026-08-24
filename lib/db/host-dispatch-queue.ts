import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import {
  HOST_DISPATCH_MAX_RESULT_CHARS,
  HOST_DISPATCH_MAX_RESULT_CHUNKS,
  HOST_DISPATCH_RESULT_CHUNK_CHARS,
  type HostDispatchDomain,
  type HostDispatchJobRow,
  type HostDispatchStatus,
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
export const HOST_DISPATCH_LEASE_MS = 2 * 60_000
export const HOST_DISPATCH_RESULT_REDELIVERY_MS = 15_000
const DEFAULT_EXPIRES_MS = 24 * 60 * 60_000
export const HOST_DISPATCH_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000

const TERMINAL_HOST_DISPATCH_STATUSES = new Set<HostDispatchStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "deadletter",
])

function isTerminalHostDispatchStatus(status: HostDispatchStatus): boolean {
  return TERMINAL_HOST_DISPATCH_STATUSES.has(status)
}

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
  expiresAt?: number
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
    expiresAt: input.expiresAt ?? now + DEFAULT_EXPIRES_MS,
    idempotencyKey: input.idempotencyKey,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.label ? { label: input.label } : {}),
  }
  try {
    await db.hostDispatchQueue.add(row)
    return row
  } catch (error) {
    if (!(error instanceof Dexie.ConstraintError)) throw error
    // A concurrent enqueue with the same key won the unique-index race. Its
    // row is the one that exists, and returning ours would dispatch the work
    // twice — the read above cannot prevent this on its own, which is why the
    // index carries the constraint.
    const winner = await db.hostDispatchQueue
      .where("idempotencyKey")
      .equals(input.idempotencyKey)
      .first()
    if (!winner) throw error
    return winner
  }
}

/** Rows due for an attempt, oldest first. */
export async function claimDueHostDispatch(
  accountId: string,
  now: number = Date.now(),
  limit = 20,
  leaseOwner = crypto.randomUUID(),
  leaseMs = HOST_DISPATCH_LEASE_MS,
  jobId?: string
): Promise<HostDispatchJobRow[]> {
  const db = getDb()
  return db.transaction("rw", db.hostDispatchQueue, async () => {
    const due = await db.hostDispatchQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", 0], ["pending", now], true, true)
      .filter((row) => row.accountId === accountId && (!jobId || row.id === jobId))
      .toArray()
    const selected = due
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
    const claimed = selected.map((row) => ({
      ...row,
      status: "inflight" as const,
      leaseOwner,
      leaseExpiresAt: now + leaseMs,
      updatedAt: now,
    }))
    await db.hostDispatchQueue.bulkPut(claimed)
    return claimed
  })
}

/** Mark a row in flight so a second runner in the same process skips it. */
export async function markHostDispatchInflight(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (row?.status !== "pending") return
    await db.hostDispatchQueue.update(id, {
      status: "inflight",
      updatedAt: now,
      leaseExpiresAt: now + HOST_DISPATCH_LEASE_MS,
    })
  })
}

export async function markHostDispatchAwaitingResult(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (row?.status !== "inflight") return
    await db.hostDispatchQueue.update(id, {
      // A transport acknowledgement is not a durable result acknowledgement.
      // Re-deliver after a bounded delay; the device receipt keyed by requestId
      // deduplicates execution, while a lost result frame no longer strands work.
      status: "pending",
      nextAttemptAt: Math.min(row.expiresAt, now + HOST_DISPATCH_RESULT_REDELIVERY_MS),
      updatedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
  })
}

export async function completeHostDispatch(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (!row || isTerminalHostDispatchStatus(row.status)) return
    await db.hostDispatchQueue.update(id, {
      status: "succeeded",
      updatedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
  })
}

export async function cancelHostDispatch(
  id: string,
  code = "cancelled",
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (!row || isTerminalHostDispatchStatus(row.status)) return
    await db.hostDispatchQueue.update(id, {
      status: "cancelled",
      terminalCode: code,
      updatedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
  })
}

export async function terminateHostDispatch(
  id: string,
  error: string,
  code: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (!row || isTerminalHostDispatchStatus(row.status)) return
    await db.hostDispatchQueue.update(id, {
      status: "failed",
      lastError: error,
      terminalCode: code,
      updatedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
  })
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
  return db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (!row) return "failed"
    if (isTerminalHostDispatchStatus(row.status)) return row.status
    const attempts = row.attempts + 1
    const exhausted = attempts >= row.maxAttempts
    const status: HostDispatchStatus = exhausted ? "deadletter" : "pending"
    await db.hostDispatchQueue.update(id, {
      status,
      attempts,
      lastError: error,
      updatedAt: now,
      nextAttemptAt: exhausted ? row.nextAttemptAt : now + hostDispatchBackoffMs(attempts),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
    return status
  })
}

/**
 * Return rows stranded `inflight` by a host that died mid-dispatch.
 *
 * Without this an interrupted dispatch stays `inflight` forever and is never
 * retried — the exact silent loss this queue exists to prevent.
 */
export async function recoverStrandedHostDispatch(
  accountId: string,
  now = Date.now(),
  jobId?: string
): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.hostDispatchQueue, async () => {
    const [expiredClaims, legacyAwaitingResults] = await Promise.all([
      db.hostDispatchQueue
        .where("[accountId+status]")
        .equals([accountId, "inflight"])
        .filter(
          (row) =>
            (!jobId || row.id === jobId) &&
            (row.leaseExpiresAt === undefined || row.leaseExpiresAt <= now)
        )
        .toArray(),
      // Versions that persisted `awaiting-result` had no redelivery wake. Move
      // those rows back into the safe, receipt-deduplicated delivery loop.
      db.hostDispatchQueue
        .where("[accountId+status]")
        .equals([accountId, "awaiting-result"])
        .filter((row) => !jobId || row.id === jobId)
        .toArray(),
    ])
    const stranded = [...expiredClaims, ...legacyAwaitingResults]
    if (stranded.length === 0) return 0
    await db.hostDispatchQueue.bulkPut(
      stranded.map((row) => ({
        ...row,
        status: "pending" as const,
        updatedAt: now,
        nextAttemptAt: now,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      }))
    )
    return stranded.length
  })
}

export interface HostDispatchResultChunk {
  requestId: string
  seq: number
  total: number
  chunk: string
}

export type StoreHostDispatchResultOutcome =
  | { ok: true; complete: boolean }
  | { ok: false; reason: "not-found" | "wrong-target" | "malformed" | "terminal" }

/** Persist one target result chunk even when no live workflow waiter exists. */
export async function storeHostDispatchResultChunk(
  fromTargetRef: string,
  payload: HostDispatchResultChunk,
  now = Date.now()
): Promise<StoreHostDispatchResultOutcome> {
  if (
    !Number.isInteger(payload.seq) ||
    !Number.isInteger(payload.total) ||
    payload.seq < 0 ||
    payload.total < 1 ||
    payload.total > HOST_DISPATCH_MAX_RESULT_CHUNKS ||
    payload.seq >= payload.total ||
    typeof payload.chunk !== "string" ||
    payload.chunk.length > HOST_DISPATCH_RESULT_CHUNK_CHARS
  ) {
    return { ok: false, reason: "malformed" }
  }
  const db = getDb()
  return db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(payload.requestId)
    if (!row) return { ok: false, reason: "not-found" }
    if (row.targetRef !== fromTargetRef) return { ok: false, reason: "wrong-target" }
    if (row.status === "succeeded") {
      const exactDuplicate =
        row.resultTotal === payload.total &&
        row.resultChunks?.[String(payload.seq)] === payload.chunk
      return exactDuplicate ? { ok: true, complete: true } : { ok: false, reason: "terminal" }
    }
    if (isTerminalHostDispatchStatus(row.status)) {
      return { ok: false, reason: "terminal" }
    }
    if (row.resultTotal !== undefined && row.resultTotal !== payload.total) {
      return { ok: false, reason: "malformed" }
    }
    const existingChunk = row.resultChunks?.[String(payload.seq)]
    if (existingChunk !== undefined && existingChunk !== payload.chunk) {
      return { ok: false, reason: "malformed" }
    }
    const resultChunks = { ...(row.resultChunks ?? {}), [String(payload.seq)]: payload.chunk }
    const resultChars = Object.values(resultChunks).reduce(
      (total, chunk) => total + chunk.length,
      0
    )
    if (resultChars > HOST_DISPATCH_MAX_RESULT_CHARS) {
      return { ok: false, reason: "malformed" }
    }
    const complete = Object.keys(resultChunks).length === payload.total
    const resultJson = complete
      ? Array.from({ length: payload.total }, (_, index) => resultChunks[String(index)] ?? "").join(
          ""
        )
      : undefined
    await db.hostDispatchQueue.update(row.id, {
      resultTotal: payload.total,
      resultChunks,
      ...(resultJson === undefined ? {} : { resultJson, status: "succeeded" as const }),
      updatedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    })
    return { ok: true, complete }
  })
}

/**
 * Record the id the target minted for this dispatch.
 *
 * Written before the row settles so a Host that dies between the target's
 * acknowledgement and its own completion still knows a remote run exists — the
 * alternative is a source that offers to cancel work the target already
 * admitted.
 */
export async function recordHostDispatchRemoteRun(
  id: string,
  remoteRunId: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.hostDispatchQueue, async () => {
    const row = await db.hostDispatchQueue.get(id)
    if (!row || row.remoteRunId === remoteRunId) return
    await db.hostDispatchQueue.update(id, { remoteRunId, updatedAt: now })
  })
}

/** Read a complete result; retain it until the owning workflow journal settles. */
export async function consumeHostDispatchResult(id: string): Promise<string | undefined> {
  return (await getDb().hostDispatchQueue.get(id))?.resultJson
}

export async function listHostDispatchForRun(runId: string): Promise<HostDispatchJobRow[]> {
  return getDb().hostDispatchQueue.where("runId").equals(runId).toArray()
}

/**
 * Every dispatch row addressed to one target, newest first.
 *
 * Reads the `targetRef` index rather than scanning, and returns terminal rows
 * too: the device console's question is "what has been sent here and how did it
 * go", and hiding the failures would answer only the half that never needed
 * explaining.
 *
 * `targetRef` is in the target's OWN vocabulary — a `hostRef` for a worker, a
 * `deviceId` for a paired device, a remote-host id for a handoff — so callers
 * holding a namespaced console ref must translate first.
 */
export async function listHostDispatchForTarget(
  targetRef: string,
  limit = 50
): Promise<HostDispatchJobRow[]> {
  const rows = await getDb().hostDispatchQueue.where("targetRef").equals(targetRef).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export async function listDeadLetteredHostDispatch(
  accountId: string
): Promise<HostDispatchJobRow[]> {
  return getDb()
    .hostDispatchQueue.where("[accountId+status]")
    .equals([accountId, "deadletter"])
    .toArray()
}

/** Delete terminal dispatch payloads after the bounded recovery/diagnostic window. */
export async function pruneTerminalHostDispatch(
  now = Date.now(),
  retentionMs = HOST_DISPATCH_TERMINAL_RETENTION_MS
): Promise<number> {
  const db = getDb()
  const cutoff = now - retentionMs
  return db.transaction("rw", db.hostDispatchQueue, async () => {
    const terminalRows = await db.hostDispatchQueue
      .filter((row) => isTerminalHostDispatchStatus(row.status) && row.updatedAt <= cutoff)
      .primaryKeys()
    await db.hostDispatchQueue.bulkDelete(terminalRows)
    return terminalRows.length
  })
}
