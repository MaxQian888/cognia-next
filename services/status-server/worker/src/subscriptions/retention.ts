/**
 * Subscription retention (plan §7/§10), run under the retention lease:
 * - pending entries whose double opt-in started more than 24 h ago are
 *   deleted with their tokens (their confirmation links have expired);
 * - unsubscribed entries are deleted entirely once `purge_after` passes
 *   (30 days after unsubscribing);
 * - suppressed entries (the provider refused the address) are reduced to
 *   their suppression record once `purge_after` passes: the HMAC index, its
 *   key ID, the state and the reason. The ciphertext and preferences are
 *   dropped. The HMAC is kept so a later signup for that address is still
 *   recognised and sent nothing; it cannot be reversed to the address;
 * - expired tokens and rate buckets are deleted;
 * - a bounded batch of rows indexed or encrypted under an older key ID is
 *   re-keyed to the current keys (see `./keys.ts` for the rotation runbook).
 * Every write is lease-guarded and bounded per run.
 */

import { DAY_MS, HOUR_MS } from "../../../../../lib/status/contract"
import { logEvent } from "../platform/http"
import { leaseGuard } from "../platform/lease"
import type { JobContext } from "../seams"
import { emailHmacs, encKeyRing, encryptEmail, hmacKeyRing } from "./keys"
import { SUBSCRIBER_COLUMNS, subscriberEmail, type SubscriberRow } from "./store"

export const PENDING_TTL_MS = DAY_MS
/** Used / expired tokens are kept a little past expiry for idempotent retries. */
export const TOKEN_GRACE_MS = 7 * DAY_MS
export const RETENTION_BATCH = 200
export const REKEY_BATCH = 50

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ")
}

async function deleteSubscribers(job: JobContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = job.env.DB
  const guard = leaseGuard(job.lease, job.nowMs)
  const list = placeholders(ids.length)
  await db.batch([
    db
      .prepare(
        `UPDATE outbox SET state = 'cancelled', last_error_code = 'subscriber_purged', subject = NULL,
           text_body = NULL, html_body = NULL, updated_at = ?
         WHERE subscriber_id IN (${list}) AND state IN ('pending', 'retryable_failure') AND ${guard.sql}`
      )
      .bind(job.nowMs, ...ids, ...guard.params),
    db
      .prepare(`DELETE FROM subscriber_tokens WHERE subscriber_id IN (${list}) AND ${guard.sql}`)
      .bind(...ids, ...guard.params),
    db
      .prepare(`DELETE FROM subscribers WHERE id IN (${list}) AND ${guard.sql}`)
      .bind(...ids, ...guard.params),
  ])
}

async function rekey(job: JobContext): Promise<number> {
  const hmacRing = hmacKeyRing(job.env)
  const encRing = encKeyRing(job.env)
  if (!hmacRing || !encRing) return 0
  const db = job.env.DB
  const rows = await db
    .prepare(
      `SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers
       WHERE email_ciphertext IS NOT NULL AND (email_hmac_key_id != ? OR email_key_id != ?)
       LIMIT ?`
    )
    .bind(hmacRing.currentId, encRing.currentId, REKEY_BATCH)
    .all<SubscriberRow>()
  let rekeyed = 0
  for (const row of rows.results) {
    const email = await subscriberEmail(encRing, row)
    if (!email) {
      // The key that sealed it is gone: nothing can be recovered or sent.
      logEvent("subscription.rekey_failed", { subscriberId: row.id, keyId: row.email_key_id })
      continue
    }
    const [current] = await emailHmacs(
      { currentId: hmacRing.currentId, keys: hmacRing.keys.slice(0, 1) },
      email
    )
    if (!current) continue
    const sealed = await encryptEmail(encRing, row.id, email)
    const guard = leaseGuard(job.lease, job.nowMs)
    const result = await db
      .prepare(
        `UPDATE subscribers SET email_hmac = ?, email_hmac_key_id = ?, email_ciphertext = ?, email_key_id = ?
         WHERE id = ? AND email_hmac = ? AND email_ciphertext = ? AND ${guard.sql}`
      )
      .bind(
        current.hmac,
        current.keyId,
        sealed.ciphertext,
        sealed.keyId,
        row.id,
        row.email_hmac,
        row.email_ciphertext,
        ...guard.params
      )
      .run()
    rekeyed += result.meta.changes
  }
  return rekeyed
}

export async function runSubscriptionRetention(job: JobContext): Promise<void> {
  const db = job.env.DB
  const now = job.nowMs
  const guard = leaseGuard(job.lease, now)

  const expiredPending = await db
    .prepare(`SELECT id FROM subscribers WHERE state = 'pending' AND pending_since < ? LIMIT ?`)
    .bind(now - PENDING_TTL_MS, RETENTION_BATCH)
    .all<{ id: string }>()
  await deleteSubscribers(
    job,
    expiredPending.results.map((row) => row.id)
  )

  const purgeable = await db
    .prepare(`SELECT id FROM subscribers WHERE state = 'unsubscribed' AND purge_after <= ? LIMIT ?`)
    .bind(now, RETENTION_BATCH)
    .all<{ id: string }>()
  await deleteSubscribers(
    job,
    purgeable.results.map((row) => row.id)
  )

  const suppressed = await db
    .prepare(
      `UPDATE subscribers SET email_ciphertext = NULL, email_key_id = NULL, component_ids_json = '[]',
         write_token = NULL, updated_at = ?
       WHERE id IN (SELECT id FROM subscribers WHERE state = 'suppressed' AND purge_after <= ?
                    AND email_ciphertext IS NOT NULL LIMIT ?)
         AND ${guard.sql}`
    )
    .bind(now, now, RETENTION_BATCH, ...guard.params)
    .run()

  const tokens = await db
    .prepare(
      `DELETE FROM subscriber_tokens WHERE token_hash IN (SELECT token_hash FROM subscriber_tokens
         WHERE expires_at < ? LIMIT ?) AND ${guard.sql}`
    )
    .bind(now - TOKEN_GRACE_MS, RETENTION_BATCH * 5, ...guard.params)
    .run()

  const buckets = await db
    .prepare(
      `DELETE FROM rate_buckets WHERE bucket IN (SELECT bucket FROM rate_buckets WHERE expires_at < ? LIMIT ?)
         AND ${guard.sql}`
    )
    .bind(now - HOUR_MS, RETENTION_BATCH * 5, ...guard.params)
    .run()

  const rekeyed = await rekey(job)
  logEvent("subscription.retention", {
    pendingDeleted: expiredPending.results.length,
    unsubscribedPurged: purgeable.results.length,
    suppressedReduced: suppressed.meta.changes,
    tokensDeleted: tokens.meta.changes,
    bucketsDeleted: buckets.meta.changes,
    rekeyed,
    fence: job.lease.fence,
  })
}
