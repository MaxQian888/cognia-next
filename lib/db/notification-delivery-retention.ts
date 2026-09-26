// Retention for Notification V2's delivery ledger (ADR-0190).
//
// The ledger grows with every notification that leaves the app, and nothing
// else ever removes a row. It follows the inbox's own window
// (`NotificationPreferences.retentionMaxAgeMs`): once a delivery has settled
// and aged past it, the history the inbox no longer shows is not kept either.
//
// What goes and what stays is decided by what the rows are still FOR:
//
// - A settled intent is COMPACTED, never deleted. Its `operationKey` is the
//   unique key that turns a second delivery of the same fact into a no-op, so
//   dropping the row would let a re-projected run (a bumped projection
//   generation re-opens every run in a scope) send a month-old notification to
//   a real chat again. The rendered text and the frozen address go; the key,
//   status, target, times and `contentHash` (suppress-if-unchanged compares
//   against it) stay, and the run's Notifications tab keeps listing it.
// - `delivery-unknown` is never touched: it is terminal but unverified, and it
//   stays whole and visible until someone resolves it. Unsettled intents are
//   in flight and belong to the sender and the reconciler.
// - A compacted intent's send attempts are deleted with it. They explain a
//   settled outcome; the stale-send recovery reads attempts only for intents
//   still `sending`.
// - Timers that fired, were cancelled or expired, digest members that were
//   flushed, and publications that were closed or superseded and that no whole
//   intent points at are deleted — nothing reads a settled one again.
//
// Projection work, policy state, result summaries, targets and subscriptions
// are left alone: they are what a re-projection is decided against.

import Dexie from "dexie"

import {
  COMPACTABLE_INTENT_STATUSES,
  isWholeIntent,
  type CompactedNotificationDeliveryIntent,
  type WholeNotificationDeliveryIntent,
} from "@/types/notifications/delivery"
import { getDb } from "./schema"

/** Rows handled per transaction — keeps one sweep from holding the store. */
const BATCH_SIZE = 200

const SETTLED_TIMER_STATES = ["fired", "cancelled", "expired"] as const
const SETTLED_PUBLICATION_STATES = ["closed", "superseded"] as const

export interface NotificationDeliveryRetentionReport {
  intentsCompacted: number
  attemptsDeleted: number
  timersDeleted: number
  aggregateMembersDeleted: number
  publicationsDeleted: number
}

/** A settled intent reduced to what dedupe, materiality and the run tab read. */
export function compactIntent(
  intent: WholeNotificationDeliveryIntent & {
    status: CompactedNotificationDeliveryIntent["status"]
  },
  now: number
): CompactedNotificationDeliveryIntent {
  const { payload, targetAddress, compactedAt: _whole, ...rest } = intent
  return {
    ...rest,
    status: intent.status,
    targetAddress: { kind: targetAddress.kind },
    payload: {
      level: payload.level,
      disclosureLevel: payload.disclosureLevel,
      clippedFactCount: payload.clippedFactCount,
      contentHash: payload.contentHash,
    },
    compactedAt: now,
  }
}

function isCompactable(
  intent: WholeNotificationDeliveryIntent
): intent is WholeNotificationDeliveryIntent & {
  status: CompactedNotificationDeliveryIntent["status"]
} {
  return (COMPACTABLE_INTENT_STATUSES as readonly string[]).includes(intent.status)
}

/**
 * Compact settled intents and delete settled bookkeeping last touched before
 * `cutoff`. Idempotent: a second run over the same rows changes nothing.
 */
export async function pruneNotificationDelivery(opts: {
  cutoff: number
  now: number
}): Promise<NotificationDeliveryRetentionReport> {
  const report: NotificationDeliveryRetentionReport = {
    intentsCompacted: 0,
    attemptsDeleted: 0,
    timersDeleted: 0,
    aggregateMembersDeleted: 0,
    publicationsDeleted: 0,
  }
  await compactSettledIntents(opts, report)
  report.timersDeleted = await deleteSettledTimers(opts.cutoff)
  report.aggregateMembersDeleted = await deleteFlushedMembers(opts.cutoff)
  report.publicationsDeleted = await deleteSettledPublications(opts.cutoff)
  return report
}

async function compactSettledIntents(
  opts: { cutoff: number; now: number },
  report: NotificationDeliveryRetentionReport
): Promise<void> {
  const db = getDb()
  // Settled and aged, not yet compacted. Collected as keys first so each
  // batch re-reads its rows inside the transaction that rewrites them.
  const keys = (await db.notificationDeliveryIntents
    .where("status")
    .anyOf([...COMPACTABLE_INTENT_STATUSES])
    .filter((intent) => isWholeIntent(intent) && intent.updatedAt < opts.cutoff)
    .primaryKeys()) as string[]
  for (let start = 0; start < keys.length; start += BATCH_SIZE) {
    const batch = keys.slice(start, start + BATCH_SIZE)
    await db.transaction(
      "rw",
      db.notificationDeliveryIntents,
      db.notificationDeliveryAttempts,
      async () => {
        const rows = await db.notificationDeliveryIntents.bulkGet(batch)
        const compacted: CompactedNotificationDeliveryIntent[] = []
        for (const row of rows) {
          // Re-checked: the row may have moved since the key scan.
          if (!row || !isWholeIntent(row) || !isCompactable(row)) continue
          if (row.updatedAt >= opts.cutoff) continue
          compacted.push(compactIntent(row, opts.now))
        }
        if (compacted.length === 0) return
        await db.notificationDeliveryIntents.bulkPut(compacted)
        report.intentsCompacted += compacted.length
        report.attemptsDeleted += await db.notificationDeliveryAttempts
          .where("intentId")
          .anyOf(compacted.map((intent) => intent.id))
          .delete()
      }
    )
  }
}

async function deleteSettledTimers(cutoff: number): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.notificationTimers, () =>
    db.notificationTimers
      .where("state")
      .anyOf([...SETTLED_TIMER_STATES])
      .filter((timer) => timer.updatedAt < cutoff)
      .delete()
  )
}

async function deleteFlushedMembers(cutoff: number): Promise<number> {
  const db = getDb()
  // Unflushed members carry no `flushedAt`, so the index never lists them.
  return db.transaction("rw", db.notificationAggregateMembers, () =>
    db.notificationAggregateMembers.where("flushedAt").between(Dexie.minKey, cutoff).delete()
  )
}

async function deleteSettledPublications(cutoff: number): Promise<number> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.notificationPublications,
    db.notificationDeliveryIntents,
    async () => {
      const candidates = await db.notificationPublications
        .where("state")
        .anyOf([...SETTLED_PUBLICATION_STATES])
        .filter((publication) => publication.updatedAt < cutoff)
        .toArray()
      const doomed: string[] = []
      for (const publication of candidates) {
        // A whole intent still pointing here may yet fold a receipt onto it.
        const referencing = await db.notificationDeliveryIntents
          .where("publicationId")
          .equals(publication.id)
          .toArray()
        if (referencing.some(isWholeIntent)) continue
        doomed.push(publication.id)
      }
      if (doomed.length > 0) await db.notificationPublications.bulkDelete(doomed)
      return doomed.length
    }
  )
}
