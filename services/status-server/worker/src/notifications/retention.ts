/**
 * Notification retention (plan §7: delivery metadata 30 days, no body or
 * recipient kept longer than needed). Under the retention lease, bounded:
 * - bodies of finished rows (accepted, failed for good, suppressed,
 *   cancelled) are nulled one day after they finished; `uncertain` rows keep
 *   theirs until resolved, an operator retry needs them;
 * - outbox rows untouched for 30 days are deleted, except rows still in
 *   flight (pending / leased / retryable);
 * - fanned-out events older than 30 days with no remaining outbox row are
 *   deleted;
 * - operator alert de-duplication rows older than 30 days are deleted.
 */

import { DAY_MS } from "../../../../../lib/status/contract"
import { logEvent } from "../platform/http"
import { leaseGuard } from "../platform/lease"
import type { JobContext } from "../seams"

export const BODY_RETENTION_MS = DAY_MS
export const METADATA_RETENTION_MS = 30 * DAY_MS
export const RETENTION_BATCH = 500

export async function runNotificationRetention(job: JobContext): Promise<void> {
  const db = job.env.DB
  const now = job.nowMs
  const guard = leaseGuard(job.lease, now)
  const results = await db.batch([
    db
      .prepare(
        `UPDATE outbox SET subject = NULL, text_body = NULL, html_body = NULL
         WHERE id IN (SELECT id FROM outbox
                      WHERE state IN ('provider_accepted', 'terminal_failure', 'suppressed', 'cancelled')
                        AND updated_at < ? AND text_body IS NOT NULL LIMIT ?)
           AND ${guard.sql}`
      )
      .bind(now - BODY_RETENTION_MS, RETENTION_BATCH, ...guard.params),
    db
      .prepare(
        `DELETE FROM outbox WHERE id IN (SELECT id FROM outbox
           WHERE state NOT IN ('pending', 'leased', 'retryable_failure') AND updated_at < ? LIMIT ?)
           AND ${guard.sql}`
      )
      .bind(now - METADATA_RETENTION_MS, RETENTION_BATCH, ...guard.params),
    db
      .prepare(
        `DELETE FROM notification_events WHERE id IN (SELECT e.id FROM notification_events e
           WHERE e.fanout_done = 1 AND e.created_at < ?
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.id) LIMIT ?)
           AND ${guard.sql}`
      )
      .bind(now - METADATA_RETENTION_MS, RETENTION_BATCH, ...guard.params),
    db
      .prepare(
        `DELETE FROM operator_alerts WHERE key IN (SELECT key FROM operator_alerts WHERE last_sent_at < ? LIMIT ?)
           AND ${guard.sql}`
      )
      .bind(now - METADATA_RETENTION_MS, RETENTION_BATCH, ...guard.params),
  ])
  logEvent("notification.retention", {
    bodiesCleared: results[0]?.meta.changes ?? 0,
    rowsDeleted: results[1]?.meta.changes ?? 0,
    eventsDeleted: results[2]?.meta.changes ?? 0,
    alertsDeleted: results[3]?.meta.changes ?? 0,
    fence: job.lease.fence,
  })
}
