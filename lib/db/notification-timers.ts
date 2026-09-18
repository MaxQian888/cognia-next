// Dexie access for Notification V2 timers (v227).
//
// A timer is cancellable scheduled notification work — quiet-hours release,
// digest flush, escalation, retry backoff, approval expiry, materiality
// re-check. `cancelToken` is the invalidation handle: cancelling bumps the
// row's token so a stale armed timer that already fired can't resurrect, and
// the firing path verifies the token it read still matches before acting.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { NotificationTimer, NotificationTimerKind } from "@/types/notifications/delivery"

export type { NotificationTimer, NotificationTimerKind }

/**
 * Arm a timer. `cancelToken` is caller-supplied when the timer replaces an
 * existing one (the sweep uses the same token to cancel the old row first);
 * otherwise a fresh token is minted.
 */
export async function armNotificationTimer(
  input: Omit<NotificationTimer, "id" | "state" | "cancelToken" | "createdAt" | "updatedAt"> & {
    cancelToken?: string
  },
  txDb?: CogniaDB
): Promise<NotificationTimer> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const row: NotificationTimer = {
    ...input,
    id: nanoid(),
    state: "armed",
    cancelToken: input.cancelToken ?? nanoid(),
    createdAt: now,
    updatedAt: now,
  }
  const run = async (): Promise<NotificationTimer> => {
    await db.notificationTimers.put(row)
    return row
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationTimers, run)
}

/** All armed timers due at/before `now` — the firing sweep's candidate set. */
export async function listDueTimers(now = Date.now()): Promise<NotificationTimer[]> {
  return getDb()
    .notificationTimers.where("[state+dueAt]")
    .between(["armed", 0], ["armed", now])
    .toArray()
}

/**
 * Fire a due timer — marks it `fired` only if its `cancelToken` still matches
 * the one the caller read (a cancellation that landed between read and fire
 * invalidates this shot). Returns the fired row, or `undefined` when the
 * token was invalidated or the timer was already resolved.
 */
export async function fireNotificationTimer(
  timerId: string,
  expectedCancelToken: string
): Promise<NotificationTimer | undefined> {
  const db = getDb()
  const now = Date.now()
  return db.transaction("rw", db.notificationTimers, async () => {
    const row = await db.notificationTimers.get(timerId)
    if (!row || row.state !== "armed" || row.cancelToken !== expectedCancelToken) return undefined
    const next: NotificationTimer = { ...row, state: "fired", updatedAt: now }
    await db.notificationTimers.put(next)
    return next
  })
}

/**
 * Cancel every armed timer matching a fact/intent/aggregate — the ACK /
 * revocation / read-state-cancel path. Marks them `cancelled` with a reason
 * and rotates the token so a concurrent fire loses its CAS. Returns count.
 */
export async function cancelTimersFor(
  match: {
    factKey?: string
    intentId?: string
    aggregateKey?: string
    notificationId?: string
    kind?: NotificationTimerKind
  },
  reason: string
): Promise<number> {
  const db = getDb()
  const now = Date.now()
  let cancelled = 0
  await db.transaction("rw", db.notificationTimers, async () => {
    const rows = await db.notificationTimers.where("state").equals("armed").toArray()
    for (const row of rows) {
      if (match.kind !== undefined && row.kind !== match.kind) continue
      if (match.factKey !== undefined && row.factKey !== match.factKey) continue
      if (match.intentId !== undefined && row.intentId !== match.intentId) continue
      if (match.aggregateKey !== undefined && row.aggregateKey !== match.aggregateKey) continue
      if (match.notificationId !== undefined && row.notificationId !== match.notificationId) {
        continue
      }
      await db.notificationTimers.put({
        ...row,
        state: "cancelled",
        cancelReason: reason,
        cancelToken: nanoid(), // rotate — a concurrent fire's CAS now fails
        updatedAt: now,
      })
      cancelled += 1
    }
  })
  return cancelled
}

/** Timers still armed for one fact — diagnostics / quiet-release reads. */
export async function listArmedTimersForFact(factKey: string): Promise<NotificationTimer[]> {
  return getDb()
    .notificationTimers.where("factKey")
    .equals(factKey)
    .filter((t) => t.state === "armed")
    .toArray()
}
