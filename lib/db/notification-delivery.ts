// Dexie access for Notification V2 delivery intents + attempts (v227).
//
// An intent is the durable *intent* to perform ONE governed delivery op; an
// attempt is the append-only evidence of each actual send. Intents carry the
// `operationKey` (unique index — the operation-authority key that the paired
// `outboundQueue.notificationOperationKey` mirrors), the frozen target
// address + payload, and the status machine. Attempts are never mutated —
// a late platform receipt appends a NEW attempt rather than rewriting an
// earlier `timeout-unknown`.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type {
  NotificationDeliveryAttempt,
  NotificationDeliveryIntent,
  NotificationAttemptOutcome,
} from "@/types/notifications/delivery"

export type { NotificationDeliveryAttempt, NotificationDeliveryIntent, NotificationAttemptOutcome }

/** Terminal intent statuses — no further send transitions out of these. */
export const TERMINAL_INTENT_STATUSES: readonly NotificationDeliveryIntent["status"][] = [
  "accepted",
  "rejected",
  "failed",
  "delivery-unknown",
  "superseded",
  "cancelled",
  "expired",
] as const

/**
 * Persist a prepared intent, inside the caller's transaction when supplied.
 * The unique `operationKey` index enforces operation uniqueness — a second
 * persist of the same key throws a ConstraintError, which the coordinator
 * treats as "already persisted" (idempotent re-entry). Returns the row.
 */
export async function persistDeliveryIntent(
  intent: Omit<NotificationDeliveryIntent, "id" | "createdAt" | "updatedAt" | "attemptCount"> & {
    attemptCount?: number
  },
  txDb?: CogniaDB
): Promise<NotificationDeliveryIntent> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const row: NotificationDeliveryIntent = {
    ...intent,
    id: nanoid(),
    attemptCount: intent.attemptCount ?? 0,
    createdAt: now,
    updatedAt: now,
  }
  const run = async (): Promise<NotificationDeliveryIntent> => {
    await db.notificationDeliveryIntents.put(row)
    return row
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationDeliveryIntents, run)
}

/** Find an intent by its operation-authority key — idempotent re-entry. */
export async function getIntentByOperationKey(
  operationKey: string
): Promise<NotificationDeliveryIntent | undefined> {
  return getDb().notificationDeliveryIntents.where("operationKey").equals(operationKey).first()
}

export async function getDeliveryIntent(
  id: string
): Promise<NotificationDeliveryIntent | undefined> {
  return getDb().notificationDeliveryIntents.get(id)
}

/** The single live (non-terminal) intent occupying a delivery slot, if any. */
export async function getLiveIntentForSlot(
  slotKey: string
): Promise<NotificationDeliveryIntent | undefined> {
  const rows = await getDb().notificationDeliveryIntents.where("slotKey").equals(slotKey).toArray()
  return rows.find((r) => !TERMINAL_INTENT_STATUSES.includes(r.status))
}

/** CAS-update an intent's status — the send lifecycle's transitions. */
export async function transitionIntent(
  intentId: string,
  expectedStatus:
    NotificationDeliveryIntent["status"] | readonly NotificationDeliveryIntent["status"][],
  patch: Partial<NotificationDeliveryIntent>,
  txDb?: CogniaDB
): Promise<NotificationDeliveryIntent | undefined> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
  const run = async (): Promise<NotificationDeliveryIntent | undefined> => {
    const row = await db.notificationDeliveryIntents.get(intentId)
    if (!row || !allowed.includes(row.status)) return undefined
    const next: NotificationDeliveryIntent = { ...row, ...patch, id: row.id, updatedAt: now }
    await db.notificationDeliveryIntents.put(next)
    return next
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationDeliveryIntents, run)
}

/** Close every live intent for a slot except `exceptId` — supersede sweep. */
export async function supersedeSlotIntents(
  slotKey: string,
  exceptId: string,
  txDb?: CogniaDB
): Promise<void> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<void> => {
    const rows = await db.notificationDeliveryIntents.where("slotKey").equals(slotKey).toArray()
    for (const row of rows) {
      if (row.id === exceptId || TERMINAL_INTENT_STATUSES.includes(row.status)) continue
      await db.notificationDeliveryIntents.put({
        ...row,
        status: "superseded",
        updatedAt: now,
      })
    }
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationDeliveryIntents, run)
}

/** Cancel a queued/prepared intent that has not yet sent — revocation path. */
export async function cancelIntent(
  intentId: string,
  txDb?: CogniaDB
): Promise<NotificationDeliveryIntent | undefined> {
  return transitionIntent(
    intentId,
    ["prepared", "queued", "sending"],
    { status: "cancelled" },
    txDb
  )
}

/**
 * Append a send attempt + update the owning intent's attempt bookkeeping in
 * one transaction. `attemptIndex` is allocated as `intent.attemptCount + 1`
 * INSIDE the transaction so concurrent sub-attempts can't collide.
 */
export async function appendDeliveryAttempt(
  input: {
    intentId: string
    outcome: NotificationAttemptOutcome
    receipt?: NotificationDeliveryAttempt["receipt"]
    errorCode?: string
    errorClass?: string
    startedAt: number
    outboundJobId?: string
    subAttempt?: number
  },
  txDb?: CogniaDB
): Promise<NotificationDeliveryAttempt> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<NotificationDeliveryAttempt> => {
    const intent = await db.notificationDeliveryIntents.get(input.intentId)
    if (!intent) throw new Error(`intent-not-found:${input.intentId}`)
    const attempt: NotificationDeliveryAttempt = {
      id: nanoid(),
      intentId: input.intentId,
      attemptIndex: intent.attemptCount + 1,
      ...(input.subAttempt !== undefined ? { subAttempt: input.subAttempt } : {}),
      outcome: input.outcome,
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      startedAt: input.startedAt,
      finishedAt: now,
      ...(input.outboundJobId ? { outboundJobId: input.outboundJobId } : {}),
      createdAt: now,
    }
    await db.notificationDeliveryAttempts.put(attempt)
    await db.notificationDeliveryIntents.put({
      ...intent,
      attemptCount: intent.attemptCount + 1,
      lastAttemptAt: now,
      updatedAt: now,
    })
    return attempt
  }
  if (txDb) return run()
  return db.transaction(
    "rw",
    [db.notificationDeliveryAttempts, db.notificationDeliveryIntents],
    run
  )
}

/** Append-only history of one intent's attempts, in send order. */
export async function listAttemptsForIntent(
  intentId: string
): Promise<NotificationDeliveryAttempt[]> {
  const rows = await getDb()
    .notificationDeliveryAttempts.where("intentId")
    .equals(intentId)
    .toArray()
  return rows.sort((a, b) => a.attemptIndex - b.attemptIndex)
}

/** All intents for a notification fact — the delivery diagnostics view. */
export async function listIntentsForNotification(
  notificationId: string
): Promise<NotificationDeliveryIntent[]> {
  return getDb()
    .notificationDeliveryIntents.where("notificationId")
    .equals(notificationId)
    .toArray()
}

/** All intents for one fact's logical key — dedupe/materiality baselines. */
export async function listIntentsForLogicalKey(
  logicalKey: string
): Promise<NotificationDeliveryIntent[]> {
  return getDb().notificationDeliveryIntents.where("logicalKey").equals(logicalKey).toArray()
}

/**
 * All intents serving one run — the run-detail diagnostics. Run facts key on
 * `run:{runId}:{slot}` (see `runFactLogicalKey`), so a `startsWith` scan on the
 * indexed `logicalKey` returns every delivery op the run produced in one pass.
 */
export async function listIntentsForRun(runId: string): Promise<NotificationDeliveryIntent[]> {
  return getDb()
    .notificationDeliveryIntents.where("logicalKey")
    .startsWith(`run:${runId}:`)
    .toArray()
}

/** Intents still eligible to send at `now` — the delivery runtime's scan. */
export async function listSendableIntents(now = Date.now()): Promise<NotificationDeliveryIntent[]> {
  return getDb()
    .notificationDeliveryIntents.where("status")
    .anyOf("prepared", "queued")
    .filter((i) => {
      if (i.notBefore !== undefined && i.notBefore > now) return false
      if (i.expiresAt !== undefined && i.expiresAt <= now) return false
      if (i.nextAttemptAt !== undefined && i.nextAttemptAt > now) return false
      return true
    })
    .toArray()
}

/**
 * Intents that went `sending` but never resolved — the stale-send recovery
 * the reconciler runs. A job crashed mid-send leaves `sending` forever; the
 * recovery re-queues or marks `delivery-unknown` based on the attempt log.
 */
export async function listStaleSendingIntents(
  staleBefore: number
): Promise<NotificationDeliveryIntent[]> {
  return getDb()
    .notificationDeliveryIntents.where("status")
    .equals("sending")
    .filter((i) => (i.lastAttemptAt ?? i.updatedAt) < staleBefore)
    .toArray()
}
