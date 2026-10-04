/** The `account_deletion` table (migrations/0003_account_deletion.sql). */

export type DeletionStatus = "pending" | "cancelled" | "purged"

export interface DeletionRecord {
  userId: string
  status: DeletionStatus
  requestedAt: string
  purgeAfter: string
  cancelledAt: string | null
  purgedAt: string | null
}

interface Row {
  user_id: string
  status: DeletionStatus
  requested_at: string
  purge_after: string
  cancelled_at: string | null
  purged_at: string | null
}

function fromRow(row: Row): DeletionRecord {
  return {
    userId: row.user_id,
    status: row.status,
    requestedAt: row.requested_at,
    purgeAfter: row.purge_after,
    cancelledAt: row.cancelled_at,
    purgedAt: row.purged_at,
  }
}

export async function getDeletion(db: D1Database, userId: string): Promise<DeletionRecord | null> {
  const row = await db
    .prepare('SELECT * FROM "account_deletion" WHERE "user_id" = ?')
    .bind(userId)
    .first<Row>()
  return row ? fromRow(row) : null
}

/**
 * Start the cooling-off period. Idempotent: asking again while a request is
 * pending keeps the original purge date, so repeating the request never
 * pushes the deletion back or brings it forward.
 */
export async function requestDeletion(
  db: D1Database,
  userId: string,
  now: Date,
  coolingOffDays: number
): Promise<DeletionRecord> {
  const requestedAt = now.toISOString()
  const purgeAfter = new Date(now.getTime() + coolingOffDays * 24 * 60 * 60 * 1000).toISOString()
  await db
    .prepare(
      `INSERT INTO "account_deletion" ("user_id", "status", "requested_at", "purge_after")
       VALUES (?, 'pending', ?, ?)
       ON CONFLICT ("user_id") DO UPDATE SET
         "status" = 'pending', "requested_at" = excluded."requested_at",
         "purge_after" = excluded."purge_after", "cancelled_at" = NULL
       WHERE "account_deletion"."status" = 'cancelled'`
    )
    .bind(userId, requestedAt, purgeAfter)
    .run()
  return (await getDeletion(db, userId))!
}

/** Cancel a pending request. Returns the record, or null when nothing was pending. */
export async function cancelDeletion(
  db: D1Database,
  userId: string,
  now: Date
): Promise<DeletionRecord | null> {
  const result = await db
    .prepare(
      `UPDATE "account_deletion" SET "status" = 'cancelled', "cancelled_at" = ?
       WHERE "user_id" = ? AND "status" = 'pending'`
    )
    .bind(now.toISOString(), userId)
    .run()
  if (!result.meta.changes) return null
  return getDeletion(db, userId)
}

export async function dueDeletions(db: D1Database, now: Date, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT "user_id" FROM "account_deletion"
       WHERE "status" = 'pending' AND "purge_after" <= ?
       ORDER BY "purge_after" LIMIT ?`
    )
    .bind(now.toISOString(), limit)
    .all<{ user_id: string }>()
  return results.map((row) => row.user_id)
}

export async function markPurged(db: D1Database, userId: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE "account_deletion" SET "status" = 'purged', "purged_at" = ?
       WHERE "user_id" = ? AND "status" = 'pending'`
    )
    .bind(now.toISOString(), userId)
    .run()
}
