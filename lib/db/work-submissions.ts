/**
 * Durable work submission storage (ADR-0123, Dexie v169).
 *
 * Three host-local stores back one rule: work the user can see is persisted
 * before it is dispatched, and a retry replays exactly what was persisted.
 *
 *   • `workSubmissions`         — dispatch responsibility and the receipt.
 *   • `workInputBatches`        — the frozen model-side input, encrypted.
 *   • `executionContextBundles` — the frozen execution context, encrypted.
 *
 * This module is deliberately crypto-free: it moves opaque
 * {@link EncryptedContentEnvelopeV1} values in and out of Dexie and never sees
 * plaintext. Key provisioning and envelope sealing live in
 * `lib/work-submission/crypto.ts`, so a storage test needs no key material and
 * a leaked row is useless without the account's key.
 *
 * `dispatchState` here answers only "who owes a dispatch attempt".
 * `ExecutionRun.status` remains the single user-visible lifecycle authority —
 * keeping the two apart is what stops a terminal product state and a terminal
 * queue state from disagreeing.
 */

import type { EncryptedContentEnvelopeV1 } from "@cognia/rag"
import type {
  ExecutionContextRefV1,
  WorkAttachmentRefV1,
  WorkAvailabilityPolicyV1,
  WorkDispatchStateV1,
  WorkSourceKind,
  WorkSpecAuthorityV1,
  WorkTerminalOutcomeV1,
} from "@cognia/agent-config-types/work-submission"

import { getDb, withDbReopenRetry } from "./schema"

/**
 * How long a claimed submission stays claimed without a heartbeat.
 *
 * Matches the HostState action ledger (`lib/sync/host-state-store.ts`) so an
 * operator reasons about one fencing window across both queues rather than two.
 */
export const WORK_SUBMISSION_LEASE_TTL_MS = 30_000

export type ClaimedWorkSubmission = WorkSubmissionRow & { takeoverRequired?: true }
/** Frozen input and context are retained for 30 days, then centrally swept. */
export const WORK_SUBMISSION_PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface WorkSubmissionRow {
  id: string
  accountId: string
  idempotencyKey: string
  runId: string
  turnId: string
  sessionId?: string
  projectId?: string
  runtimeTargetId: string
  sourceKind: WorkSourceKind
  sourceId: string
  triggerId?: string
  availabilityPolicy: WorkAvailabilityPolicyV1
  dispatchState: WorkDispatchStateV1
  /**
   * Earliest time a claimer may take this row. Always present so the
   * `[dispatchState+nextAttemptAt]` index is dense — a Dexie compound index
   * skips any row where a component is undefined, which would make backed-off
   * rows invisible to the very sweep meant to retry them.
   */
  nextAttemptAt: number
  attemptCount: number
  /** Set only while `dispatchState === "claimed"`. */
  leaseOwner?: string
  leaseExpiresAt?: number
  inputBatchId: string
  /** Written once, CAS-guarded: the context is frozen just before dispatch. */
  contextBundleId?: string
  executionFingerprint?: string
  /** Whether the frozen spec actually governed routing, or was observed only. */
  specAuthority?: WorkSpecAuthorityV1
  terminalOutcome?: WorkTerminalOutcomeV1
  errorCode?: string
  createdAt: number
  updatedAt: number
  settledAt?: number
}

export interface WorkInputBatchRow {
  id: string
  submissionId: string
  /** Digest of the plaintext, so a replay can be proven identical. */
  digest: string
  visibleMessageIds: string[]
  attachments: WorkAttachmentRefV1[]
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  expiresAt: number
}

export interface ExecutionContextBundleRow {
  id: string
  submissionId: string
  digest: string
  projectId?: string
  workspaceBindingRef?: string
  baseRef?: string
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  expiresAt: number
}

/**
 * A submission plus the frozen rows bound to it.
 *
 * **Intentionally dormant in P0.** This is the read side of replay: a runner
 * that re-dispatches needs the frozen input and context together. P0 never
 * re-dispatches (see `lib/work-submission/bootstrap.ts`), so nothing calls it
 * yet — but the shape is what `recovery.ts` will hand to a real transport.
 */
export interface WorkSubmissionBundle {
  submission: WorkSubmissionRow
  inputBatch?: WorkInputBatchRow
  contextBundle?: ExecutionContextBundleRow
}

export async function getWorkSubmission(id: string): Promise<WorkSubmissionRow | undefined> {
  return getDb().workSubmissions.get(id)
}

/**
 * Look a submission up by its idempotency key.
 *
 * This is the read that makes at-least-once delivery safe: a redelivered
 * client action finds the original row and returns its receipt instead of
 * creating a second message, run, or task.
 */
export async function findWorkSubmissionByIdempotencyKey(
  accountId: string,
  idempotencyKey: string
): Promise<WorkSubmissionRow | undefined> {
  return getDb()
    .workSubmissions.where("[accountId+idempotencyKey]")
    .equals([accountId, idempotencyKey])
    .first()
}

export async function getWorkInputBatch(
  submissionId: string
): Promise<WorkInputBatchRow | undefined> {
  return getDb().workInputBatches.where("submissionId").equals(submissionId).first()
}

export async function getExecutionContextBundle(
  submissionId: string
): Promise<ExecutionContextBundleRow | undefined> {
  return getDb().executionContextBundles.where("submissionId").equals(submissionId).first()
}

export async function getWorkSubmissionBundle(
  id: string
): Promise<WorkSubmissionBundle | undefined> {
  const submission = await getWorkSubmission(id)
  if (!submission) return undefined
  const [inputBatch, contextBundle] = await Promise.all([
    getWorkInputBatch(id),
    getExecutionContextBundle(id),
  ])
  return {
    submission,
    ...(inputBatch ? { inputBatch } : {}),
    ...(contextBundle ? { contextBundle } : {}),
  }
}

export interface ListWorkSubmissionsQuery {
  accountId?: string
  sessionId?: string
  dispatchStates?: readonly WorkDispatchStateV1[]
  limit?: number
}

export async function listWorkSubmissions(
  query: ListWorkSubmissionsQuery = {}
): Promise<WorkSubmissionRow[]> {
  const states = query.dispatchStates ? new Set(query.dispatchStates) : undefined
  const rows = await getDb()
    .workSubmissions.orderBy("createdAt")
    .reverse()
    .filter(
      (row) =>
        (!query.accountId || row.accountId === query.accountId) &&
        (!query.sessionId || row.sessionId === query.sessionId) &&
        (!states || states.has(row.dispatchState))
    )
    .limit(query.limit ?? 100)
    .toArray()
  return rows
}

/**
 * Rows a dispatch sweep should consider, oldest attempt first.
 *
 * Includes `claimed` rows whose lease has expired: a claimer that died holding
 * a lease must not strand the work forever. The lease check is what makes
 * reclaiming safe rather than a double-dispatch.
 */
export async function listClaimableWorkSubmissions(
  now: number,
  limit = 50,
  options: { includeDispatched?: boolean } = {}
): Promise<WorkSubmissionRow[]> {
  const states = options.includeDispatched
    ? (["pending", "blocked", "claimed", "dispatched"] as const)
    : (["pending", "blocked", "claimed"] as const)
  return getDb()
    .workSubmissions.where("dispatchState")
    .anyOf(...states)
    .filter(
      (row) =>
        row.nextAttemptAt <= now &&
        (!["claimed", "dispatched"].includes(row.dispatchState) || (row.leaseExpiresAt ?? 0) <= now)
    )
    .limit(limit)
    .toArray()
}

/** Count non-terminal submissions, used to enforce the per-account backlog cap. */
export async function countOpenWorkSubmissions(accountId: string): Promise<number> {
  return getDb()
    .workSubmissions.where("dispatchState")
    .notEqual("settled")
    .filter((row) => row.accountId === accountId)
    .count()
}

/**
 * Take ownership of a submission for one dispatch attempt.
 *
 * Compare-and-set inside a transaction: the row must still be claimable *and*
 * any existing lease must have expired at the moment of the write. Two runners
 * racing therefore produce exactly one winner, and the loser sees `undefined`
 * rather than a second dispatch of the same work.
 */
export async function claimWorkSubmission(
  id: string,
  leaseOwner: string,
  now: number,
  ttlMs = WORK_SUBMISSION_LEASE_TTL_MS
): Promise<ClaimedWorkSubmission | undefined> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, async () => {
      const row = await db.workSubmissions.get(id)
      if (!row) return undefined
      const leaseHeld =
        (row.dispatchState === "claimed" || row.dispatchState === "dispatched") &&
        (row.leaseExpiresAt ?? 0) > now
      const claimable =
        row.dispatchState === "pending" ||
        row.dispatchState === "blocked" ||
        row.dispatchState === "claimed" ||
        row.dispatchState === "dispatched"
      if (!claimable || leaseHeld) return undefined
      const claimed: WorkSubmissionRow = {
        ...row,
        dispatchState: "claimed",
        leaseOwner,
        leaseExpiresAt: now + ttlMs,
        attemptCount: row.attemptCount + 1,
        updatedAt: now,
      }
      await db.workSubmissions.put(claimed)
      return row.dispatchState === "dispatched" ? { ...claimed, takeoverRequired: true } : claimed
    })
  })
}

export type WorkSubmissionLeaseRenewal = "renewed" | "closed" | "lost"

/** Extend a live assembly/runtime lease and distinguish normal closure from loss. */
export async function renewWorkSubmissionLease(
  id: string,
  leaseOwner: string,
  now: number,
  ttlMs = WORK_SUBMISSION_LEASE_TTL_MS
): Promise<WorkSubmissionLeaseRenewal> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, async () => {
      const row = await db.workSubmissions.get(id)
      if (!row || row.dispatchState === "settled") return "closed"
      if (
        (row.dispatchState !== "claimed" && row.dispatchState !== "dispatched") ||
        row.leaseOwner !== leaseOwner
      ) {
        return "lost"
      }
      await db.workSubmissions.put({ ...row, leaseExpiresAt: now + ttlMs, updatedAt: now })
      return "renewed"
    })
  })
}

/**
 * Bind the frozen execution context to a submission — write-once.
 *
 * This is the enforcement point for "a retry reuses the original context". A
 * submission that already carries a bundle is returned unchanged, so a retry
 * cannot silently re-resolve the project root, workspace, or route against
 * whatever the host looks like now.
 */
export async function bindExecutionContextBundle(
  submissionId: string,
  bundle: Omit<ExecutionContextBundleRow, "submissionId">,
  patch: { executionFingerprint?: string; specAuthority?: WorkSpecAuthorityV1 },
  now: number
): Promise<{ bound: boolean; contextBundleId: string }> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, db.executionContextBundles, async () => {
      const row = await db.workSubmissions.get(submissionId)
      if (!row) throw new Error(`Work submission not found: ${submissionId}`)
      if (row.contextBundleId) return { bound: false, contextBundleId: row.contextBundleId }
      await db.executionContextBundles.put({ ...bundle, submissionId })
      await db.workSubmissions.put({
        ...row,
        contextBundleId: bundle.id,
        ...(patch.executionFingerprint ? { executionFingerprint: patch.executionFingerprint } : {}),
        ...(patch.specAuthority ? { specAuthority: patch.specAuthority } : {}),
        updatedAt: now,
      })
      return { bound: true, contextBundleId: bundle.id }
    })
  })
}

/** Move a claimed submission to `dispatched` once the runtime has accepted it. */
export async function markWorkSubmissionDispatched(id: string, now: number): Promise<void> {
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, async () => {
      const row = await db.workSubmissions.get(id)
      if (!row || row.dispatchState === "settled") return
      await db.workSubmissions.put({ ...row, dispatchState: "dispatched", updatedAt: now })
    })
  })
}

/**
 * Return a submission to the queue after a failed or deferred attempt.
 *
 * `blocked` records "the target was unavailable" distinctly from "the attempt
 * errored", because only the former should be retried indefinitely under a
 * `wait` availability policy.
 */
export async function releaseWorkSubmission(
  id: string,
  next: {
    dispatchState: Extract<WorkDispatchStateV1, "pending" | "blocked">
    nextAttemptAt: number
    errorCode?: string
  },
  now: number
): Promise<void> {
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, async () => {
      const row = await db.workSubmissions.get(id)
      if (!row || row.dispatchState === "settled") return
      await db.workSubmissions.put({
        ...row,
        dispatchState: next.dispatchState,
        nextAttemptAt: next.nextAttemptAt,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        ...(next.errorCode ? { errorCode: next.errorCode } : {}),
        updatedAt: now,
      })
    })
  })
}

/**
 * Seal a submission. Idempotent: the first terminal outcome wins.
 *
 * Returns whether this call was the one that sealed it, so the caller can make
 * "write the assistant message exactly once" conditional on winning the race.
 */
export async function settleWorkSubmissionRow(
  id: string,
  outcome: WorkTerminalOutcomeV1,
  now: number,
  errorCode?: string
): Promise<boolean> {
  return withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.workSubmissions, async () => {
      const row = await db.workSubmissions.get(id)
      if (!row || row.dispatchState === "settled") return false
      await db.workSubmissions.put({
        ...row,
        dispatchState: "settled",
        terminalOutcome: outcome,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        ...(errorCode ? { errorCode } : {}),
        settledAt: now,
        updatedAt: now,
      })
      return true
    })
  })
}

/**
 * Central-retention hook: drop frozen payloads whose row expiry has passed.
 *
 * Only the two payload stores expire. The submission row itself is small,
 * carries no plaintext, and is the audit trail a settled run is explained by,
 * so it is not swept on this schedule.
 */
export async function pruneExpiredWorkSubmissionPayloads(now: number): Promise<number> {
  const db = getDb()
  const [inputs, contexts] = await Promise.all([
    db.workInputBatches.where("expiresAt").belowOrEqual(now).primaryKeys(),
    db.executionContextBundles.where("expiresAt").belowOrEqual(now).primaryKeys(),
  ])
  if (inputs.length === 0 && contexts.length === 0) return 0
  await withDbReopenRetry(() => {
    const database = getDb()
    return database.transaction(
      "rw",
      database.workInputBatches,
      database.executionContextBundles,
      async () => {
        await database.workInputBatches.bulkDelete(inputs as string[])
        await database.executionContextBundles.bulkDelete(contexts as string[])
      }
    )
  })
  return inputs.length + contexts.length
}

/**
 * Narrow a stored bundle row back to the shared contract's reference shape.
 *
 * **Intentionally dormant in P0.** The projection exists so a context bundle
 * can cross a host boundary as logical refs only; nothing ships one across a
 * boundary until a real dispatch transport lands.
 */
export function toExecutionContextRef(row: ExecutionContextBundleRow): ExecutionContextRefV1 {
  return {
    contextBundleId: row.id,
    digest: row.digest,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.workspaceBindingRef ? { workspaceBindingRef: row.workspaceBindingRef } : {}),
    ...(row.baseRef ? { baseRef: row.baseRef } : {}),
  }
}
