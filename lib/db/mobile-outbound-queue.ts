/**
 * CRUD + queue-mechanic helpers for the `mobileOutboundQueue` Dexie table
 * (Wave 2.1, schema v25). Keeps the queue logic out of the runner so tests
 * can exercise individual transitions without spinning up the orchestrator.
 */

import { nanoid } from "nanoid"

import type {
  MobileOutboundCommand,
  MobileOutboundJobRow,
  MobileOutboundStatus,
} from "./mobile-outbound-types"
import { decideNextAttempt } from "@/lib/queue/retry-policy"
import { getDb } from "./schema"
import {
  getActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"

export interface EnqueueInput {
  command: MobileOutboundCommand
  payload: Record<string, unknown>
  label?: string
  /** Override the auto-generated id (mainly for tests). */
  id?: string
  /** Override the auto-generated idempotency key (mainly for tests). */
  idempotencyKey?: string
  nowMs?: number
  accountId?: string
  targetId?: string
}

export async function enqueue(input: EnqueueInput): Promise<MobileOutboundJobRow> {
  const now = input.nowMs ?? Date.now()
  const activeScope = getActiveRuntimeTargetContext()
  const accountId = input.accountId ?? activeScope?.accountId
  const targetId = input.targetId ?? activeScope?.targetId
  if (!accountId || !targetId) {
    throw new Error("Outbound queue requires an active account and runtime target.")
  }
  const row: MobileOutboundJobRow = {
    id: input.id ?? nanoid(),
    accountId,
    targetId,
    command: input.command,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    idempotencyKey: input.idempotencyKey ?? nanoid(),
    label: input.label,
  }
  await getDb().mobileOutboundQueue.put(row)
  return row
}

/**
 * Atomic claim — returns the next ready row and flips status to "sending"
 * so concurrent runners don't dispatch the same job twice. Returns null
 * when nothing is ready.
 */
export async function claimNext(
  nowMs: number = Date.now(),
  scope: RuntimeTargetScope
): Promise<MobileOutboundJobRow | null> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const ready = await db.mobileOutboundQueue
      .where("status")
      .equals("pending")
      .filter(
        (row) =>
          row.accountId === scope.accountId &&
          row.targetId === scope.targetId &&
          row.nextAttemptAt <= nowMs
      )
      .first()
    if (!ready) return null
    const claimed: MobileOutboundJobRow = { ...ready, status: "sending" }
    await db.mobileOutboundQueue.put(claimed)
    return claimed
  })
}

export async function markSent(id: string): Promise<void> {
  await getDb().mobileOutboundQueue.update(id, { status: "sent" })
}

export async function recordFailure(opts: {
  id: string
  error: unknown
  nowMs?: number
  random?: () => number
}): Promise<MobileOutboundStatus> {
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const row = await db.mobileOutboundQueue.get(opts.id)
    if (!row) return "deadlettered"
    const decision = decideNextAttempt({
      attempts: row.attempts,
      error: opts.error,
      nowMs: opts.nowMs,
      random: opts.random,
    })
    await db.mobileOutboundQueue.put({
      ...row,
      status: decision.status,
      attempts: decision.attempts,
      nextAttemptAt: decision.nextAttemptAt,
      lastError: decision.lastError,
    })
    return decision.status
  })
}

export async function listByStatus(
  status: MobileOutboundStatus,
  scope = getActiveRuntimeTargetContext()
): Promise<MobileOutboundJobRow[]> {
  const collection = getDb().mobileOutboundQueue.where("status").equals(status)
  if (!scope) return collection.sortBy("createdAt")
  return collection
    .filter(
      (row) =>
        row.accountId === scope.accountId &&
        (row.targetId === scope.targetId ||
          (status === "deadlettered" && row.targetId === LEGACY_MIXED_TARGET_ID))
    )
    .sortBy("createdAt")
}

export async function listAll(): Promise<MobileOutboundJobRow[]> {
  return getDb().mobileOutboundQueue.orderBy("createdAt").toArray()
}

export async function deleteRow(id: string): Promise<void> {
  await getDb().mobileOutboundQueue.delete(id)
}

/**
 * Vacuum sent rows older than `keepMs`. Default: prune sent rows older than
 * 24 h. Deadletters stay for audit until manually cleared.
 */
export async function vacuumSent(keepMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - keepMs
  const db = getDb()
  return db.transaction("rw", db.mobileOutboundQueue, async () => {
    const stale = await db.mobileOutboundQueue
      .where("status")
      .equals("sent")
      .filter((r) => r.createdAt < cutoff)
      .toArray()
    for (const row of stale) {
      await db.mobileOutboundQueue.delete(row.id)
    }
    return stale.length
  })
}

/** Reset a deadlettered row back to pending so the user can retry manually. */
export async function retryDeadletter(id: string, nowMs: number = Date.now()): Promise<void> {
  const queue = getDb().mobileOutboundQueue
  const row = await queue.get(id)
  if (row?.targetId === LEGACY_MIXED_TARGET_ID) {
    throw new Error(
      "A legacy outbound action without an original runtime target cannot be retried."
    )
  }
  await queue.update(id, {
    status: "pending",
    attempts: 0,
    nextAttemptAt: nowMs,
    lastError: undefined,
  })
}
