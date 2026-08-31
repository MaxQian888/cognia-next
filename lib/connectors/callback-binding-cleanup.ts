/**
 * Daily cleanup for `connectorCallbackBindings`.
 *
 * Every A2UI surface the assistant sends through an adapter writes one
 * `ConnectorCallbackBindingRow` per interactive component so the inbound
 * parser can recover surface / component context when the user clicks a
 * button. Without cleanup the table grows without bound — a chatty
 * conversation that touches 10 surfaces/day with 5 buttons each adds 50
 * rows daily.
 *
 * `recordCallbackBinding` sets a default `expiresAt = createdAt + 30 d` for
 * every new row, so all that is needed is a periodic prune of rows whose
 * `expiresAt` has passed. This module provides the one-shot
 * `cleanupExpiredCallbackBindings()`, which returns the number of rows
 * deleted and is safe to call from tests and manual debug.
 *
 * It used to own a `setTimeout`/`setInterval` loop of its own. The durable
 * housekeeping clock (`lib/connectors/housekeeping-scheduler.ts`) replaced
 * that, and it is what calls this now: one persisted scheduler interval emits
 * a daily event and three event-triggered tasks fan out from it, which is what
 * gives a headless host restart and catch-up semantics an in-process timer
 * could not.
 *
 * Legacy rows from before the `expiresAt` default are also reaped: any
 * row whose `expiresAt` is undefined AND whose `createdAt` is older than
 * `LEGACY_GRACE_MS` is treated as expired. This avoids leaking pre-v45
 * bindings forever while still giving long-lived surfaces from before
 * the default-TTL rollout a 60-day grace period.
 */

import { getDb } from "@/lib/db/schema"
import { append as appendConnectorAudit } from "@/lib/db/connector-audit"

/**
 * Pre-default-TTL rows have `expiresAt === undefined`. Treat them as
 * expired when they're older than this window — long enough that any
 * surface still in flight resolves, short enough that orphans don't
 * accumulate for months.
 */
export const LEGACY_GRACE_MS = 60 * 24 * 60 * 60 * 1000

export interface CleanupResult {
  /** Rows whose explicit `expiresAt` had passed. */
  expiredCount: number
  /** Pre-default-TTL rows reaped via the legacy grace window. */
  legacyCount: number
  /** Total bindings deleted in this sweep. */
  total: number
}

/**
 * One-shot cleanup pass. Scans the `connectorCallbackBindings` table once
 * and removes both explicitly-expired rows and legacy rows older than the
 * grace window.
 */
export async function cleanupExpiredCallbackBindings(
  options: { now?: number; legacyGraceMs?: number } = {}
): Promise<CleanupResult> {
  const now = options.now ?? Date.now()
  const legacyCutoff = now - (options.legacyGraceMs ?? LEGACY_GRACE_MS)
  const db = getDb()

  let expiredCount = 0
  let legacyCount = 0
  const toDelete: string[] = []
  const auditRows: Array<{
    adapterId: string
    conversationKey?: string
    actionId: string
    expiredAt: number | undefined
    reason: "expired" | "legacy_grace"
  }> = []

  // One full-table scan is fine — the table is bounded by per-row TTL and
  // typically holds at most a few thousand entries. A compound index on
  // `expiresAt` would force a Dexie upgrade, and the table is small enough
  // that an in-memory filter is faster than the migration cost.
  await db.connectorCallbackBindings.each((row) => {
    if (typeof row.expiresAt === "number") {
      if (row.expiresAt < now) {
        expiredCount++
        toDelete.push(row.id)
        auditRows.push({
          adapterId: row.adapterId,
          conversationKey: row.conversationKey,
          actionId: row.actionId,
          expiredAt: row.expiresAt,
          reason: "expired",
        })
      }
      return
    }
    // No explicit expiry — reap when older than the legacy grace window.
    if (row.createdAt < legacyCutoff) {
      legacyCount++
      toDelete.push(row.id)
      auditRows.push({
        adapterId: row.adapterId,
        conversationKey: row.conversationKey,
        actionId: row.actionId,
        expiredAt: undefined,
        reason: "legacy_grace",
      })
    }
  })

  if (toDelete.length > 0) {
    await db.connectorCallbackBindings.bulkDelete(toDelete)
    // v49 — per-row audit so "the button stopped working" tickets can
    // reach back from the conversationKey + actionId to the pruned
    // binding. Best-effort; a failed audit write must not block the
    // bulkDelete that already landed.
    for (const audit of auditRows) {
      try {
        await appendConnectorAudit({
          adapterId: audit.adapterId,
          kind: "callback.binding_expired",
          at: now,
          conversationKey: audit.conversationKey,
          reason: audit.reason,
          fields: { actionId: audit.actionId, expiredAt: audit.expiredAt },
        })
      } catch {
        // Swallow per-row audit failures.
      }
    }
  }

  return { expiredCount, legacyCount, total: toDelete.length }
}
