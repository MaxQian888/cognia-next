/**
 * Outbox delivery through Cloudflare Email Sending (`env.EMAIL`).
 *
 * One run, under the delivery lease:
 * 1. recover rows a dead runner left `leased`: never started → `pending`;
 *    provider call started but no outcome recorded → `uncertain` (it may
 *    have been accepted; there is no idempotency key to retry safely);
 * 2. fan new events out into outbox rows (bounded);
 * 3. claim at most `DELIVERY_BATCH` due rows (`pending` / due
 *    `retryable_failure`) as `leased` with this lease's owner and fence;
 * 4. for each claimed row: start the attempt with one guarded statement that
 *    also re-checks consent, decrypt the address, call the provider with a
 *    timeout, and record the outcome guarded by the same lease.
 *
 * Unsubscribe-versus-send cutoff: the attempt-start statement requires the
 * row to still be `leased` by this runner and the subscriber to still hold
 * the row's consent version in the required state. An unsubscribe that
 * commits before that statement cancels the send (the row is `cancelled`,
 * nothing is sent). One that commits after it cannot stop a provider call
 * that is already starting: that one message may still be accepted, and
 * nothing later is sent. This is the documented, tested cutoff.
 *
 * Lease loss: every outcome write requires the lease (owner + fence +
 * unexpired). A runner that lost its lease cannot mark a row accepted or
 * failed; the next holder finds it `leased` with a started attempt and
 * marks it `uncertain` for an operator.
 *
 * Logs carry outbox / event IDs and error codes only: never addresses,
 * tokens, subjects or bodies.
 */

import { DAY_MS, type DeliveryState } from "../../../../../lib/status/contract"
import { featureOn, type Env } from "../env"
import { logEvent } from "../platform/http"
import { leaseGuard, leaseHeld } from "../platform/lease"
import type { JobContext } from "../seams"
import { emailCapability, mailSender } from "../subscriptions/capability"
import { encKeyRing } from "../subscriptions/keys"
import { readSubscriber, subscriberEmail } from "../subscriptions/store"
import { fanOutEvents } from "./fanout"
import type { OutboxPurpose } from "./outbox"
import { classifySendError, nextRetryAt, TIMEOUT_CODE, type SendOutcome } from "./retry"

export const DELIVERY_BATCH = 100
export const SEND_TIMEOUT_MS = 15_000
/** Stop starting sends once less than this remains on the lease. */
export const LEASE_SAFETY_MS = SEND_TIMEOUT_MS + 5_000
/** A suppressed subscriber keeps only its suppression record after this. */
export const SUPPRESSION_PURGE_MS = 30 * DAY_MS

export interface OutboxRow {
  id: string
  subscriber_id: string
  event_id: string
  purpose: OutboxPurpose
  consent_version: number
  state: DeliveryState
  attempts: number
  subject: string | null
  text_body: string | null
  html_body: string | null
  created_at: number
}

/** The subscriber state a row's purpose requires at send time. */
export function requiredSubscriberState(purpose: OutboxPurpose): "pending" | "confirmed" {
  return purpose === "confirmation" ? "pending" : "confirmed"
}

/** Lease-relative clock: a long run cannot outlive its lease unnoticed. */
function jobClock(job: JobContext): () => number {
  const startedReal = Date.now()
  return () => job.nowMs + Math.max(0, Date.now() - startedReal)
}

async function recoverAbandoned(job: JobContext): Promise<void> {
  const db = job.env.DB
  const guard = leaseGuard(job.lease, job.nowMs)
  const results = await db.batch([
    db
      .prepare(
        `UPDATE outbox SET state = 'pending', lease_owner = NULL, lease_fence = NULL, updated_at = ?
         WHERE state = 'leased' AND attempt_started_at IS NULL AND (lease_owner IS NULL OR lease_owner != ?)
           AND ${guard.sql}`
      )
      .bind(job.nowMs, job.lease.owner, ...guard.params),
    db
      .prepare(
        `UPDATE outbox SET state = 'uncertain', last_error_code = 'abandoned_attempt', lease_owner = NULL,
           next_attempt_at = NULL, updated_at = ?
         WHERE state = 'leased' AND attempt_started_at IS NOT NULL AND (lease_owner IS NULL OR lease_owner != ?)
           AND ${guard.sql}`
      )
      .bind(job.nowMs, job.lease.owner, ...guard.params),
  ])
  const released = results[0]?.meta.changes ?? 0
  const uncertain = results[1]?.meta.changes ?? 0
  if (released + uncertain > 0) {
    logEvent("delivery.recovered", { released, uncertain, fence: job.lease.fence })
  }
}

async function claim(job: JobContext): Promise<OutboxRow[]> {
  const db = job.env.DB
  const guard = leaseGuard(job.lease, job.nowMs)
  const result = await db
    .prepare(
      `UPDATE outbox SET state = 'leased', lease_owner = ?, lease_fence = ?, attempt_started_at = NULL, updated_at = ?
       WHERE id IN (SELECT id FROM outbox WHERE state IN ('pending', 'retryable_failure') AND next_attempt_at <= ?
                    ORDER BY next_attempt_at ASC, id ASC LIMIT ?)
         AND state IN ('pending', 'retryable_failure') AND ${guard.sql}
       RETURNING id, subscriber_id, event_id, purpose, consent_version, state, attempts, subject, text_body,
         html_body, created_at`
    )
    .bind(job.lease.owner, job.lease.fence, job.nowMs, job.nowMs, DELIVERY_BATCH, ...guard.params)
    .all<OutboxRow>()
  return result.results.sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id)
  )
}

/** Put unstarted claimed rows back when the lease is running out. */
async function releaseUnstarted(job: JobContext, ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return
  const guard = leaseGuard(job.lease, nowMs)
  await job.env.DB.prepare(
    `UPDATE outbox SET state = 'pending', lease_owner = NULL, lease_fence = NULL, updated_at = ?
     WHERE id IN (${ids.map(() => "?").join(", ")}) AND state = 'leased' AND lease_owner = ?
       AND attempt_started_at IS NULL AND ${guard.sql}`
  )
    .bind(nowMs, ...ids, job.lease.owner, ...guard.params)
    .run()
}

async function sendWithTimeout(
  env: Env,
  message: Parameters<SendEmail["send"]>[0]
): Promise<SendOutcome> {
  const binding = env.EMAIL
  if (!binding) return { kind: "terminal", code: "binding_missing" }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "uncertain", code: TIMEOUT_CODE }), SEND_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      binding.send(message).then(
        (result): SendOutcome => ({ kind: "accepted", messageId: String(result?.messageId ?? "") }),
        (error: unknown) => classifySendError(error)
      ),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type RowResult = "sent" | "skipped" | "lease_lost"

async function deliverOne(
  job: JobContext,
  row: OutboxRow,
  clock: () => number
): Promise<RowResult> {
  const db = job.env.DB
  const nowMs = clock()
  const guard = leaseGuard(job.lease, nowMs)
  const required = requiredSubscriberState(row.purpose)

  // The cutoff: attempt start = still ours + consent still valid.
  const started = await db
    .prepare(
      `UPDATE outbox SET attempt_started_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_fence = ? AND attempt_started_at IS NULL
         AND EXISTS (SELECT 1 FROM subscribers s WHERE s.id = outbox.subscriber_id
                     AND s.consent_version = outbox.consent_version AND s.state = ?)
         AND ${guard.sql}`
    )
    .bind(nowMs, nowMs, row.id, job.lease.owner, job.lease.fence, required, ...guard.params)
    .run()
  if (started.meta.changes !== 1) {
    if (!(await leaseHeld(db, job.lease, nowMs))) return "lease_lost"
    // Consent changed (or the row was cancelled under us): never send.
    const subscriber = await readSubscriber(db, row.subscriber_id)
    const state: DeliveryState = subscriber?.state === "suppressed" ? "suppressed" : "cancelled"
    await db
      .prepare(
        `UPDATE outbox SET state = ?, last_error_code = 'consent_changed', lease_owner = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ? AND ${guard.sql}`
      )
      .bind(state, nowMs, row.id, job.lease.owner, ...guard.params)
      .run()
    logEvent("delivery.skipped", { outboxId: row.id, eventId: row.event_id, state })
    return "skipped"
  }

  const subscriber = await readSubscriber(db, row.subscriber_id)
  const encRing = encKeyRing(job.env)
  const sender = mailSender(job.env)
  const address = subscriber && encRing ? await subscriberEmail(encRing, subscriber) : null
  let outcome: SendOutcome
  if (!address) {
    outcome = { kind: "terminal", code: "address_unavailable" }
  } else if (!sender) {
    outcome = { kind: "terminal", code: "sender_missing" }
  } else if (row.subject === null || row.text_body === null || row.html_body === null) {
    outcome = { kind: "terminal", code: "payload_purged" }
  } else {
    outcome = await sendWithTimeout(job.env, {
      to: address,
      from: sender,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body,
    })
  }
  // Re-read the clock: the provider call may have used most of the lease.
  return recordOutcome(job, row, outcome, clock())
}

async function recordOutcome(
  job: JobContext,
  row: OutboxRow,
  outcome: SendOutcome,
  clockNow: number
): Promise<RowResult> {
  const db = job.env.DB
  const guard = leaseGuard(job.lease, clockNow)
  const attempts = row.attempts + 1
  let state: DeliveryState
  let nextAttemptAt: number | null = null
  let code: string | null = null
  let messageId: string | null = null
  switch (outcome.kind) {
    case "accepted":
      state = "provider_accepted"
      messageId = outcome.messageId || null
      break
    case "retryable": {
      code = outcome.code
      nextAttemptAt = nextRetryAt(attempts, row.created_at, clockNow, Math.random())
      state = nextAttemptAt === null ? "terminal_failure" : "retryable_failure"
      break
    }
    case "terminal":
      state = "terminal_failure"
      code = outcome.code
      break
    case "suppressed":
      state = "suppressed"
      code = outcome.code
      break
    case "uncertain":
      state = "uncertain"
      code = outcome.code
      break
  }
  const statements = [
    db
      .prepare(
        `UPDATE outbox SET state = ?, provider_message_id = ?, last_error_code = ?, next_attempt_at = ?,
           lease_owner = NULL, attempt_started_at = CASE WHEN ? = 'retryable_failure' THEN NULL ELSE attempt_started_at END,
           updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_fence = ? AND ${guard.sql}`
      )
      .bind(
        state,
        messageId,
        code,
        nextAttemptAt,
        state,
        clockNow,
        row.id,
        job.lease.owner,
        job.lease.fence,
        ...guard.params
      ),
  ]
  if (outcome.kind === "suppressed") {
    // Provider-side suppression replaces bounce/complaint webhooks: stop
    // mailing this address and cancel what is queued for it.
    statements.push(
      db
        .prepare(
          `UPDATE subscribers SET state = 'suppressed', suppressed_reason = 'provider_suppressed',
             consent_version = consent_version + 1, purge_after = ?, updated_at = ?
           WHERE id = ? AND state IN ('pending', 'confirmed') AND changes() = 1 AND ${guard.sql}`
        )
        .bind(clockNow + SUPPRESSION_PURGE_MS, clockNow, row.subscriber_id, ...guard.params),
      db
        .prepare(
          `UPDATE outbox SET state = 'suppressed', last_error_code = 'subscriber_suppressed', updated_at = ?
           WHERE subscriber_id = ? AND state IN ('pending', 'retryable_failure') AND ${guard.sql}`
        )
        .bind(clockNow, row.subscriber_id, ...guard.params)
    )
  }
  const results = await db.batch(statements)
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    logEvent("delivery.outcome_lost", {
      outboxId: row.id,
      outcome: outcome.kind,
      fence: job.lease.fence,
    })
    return "lease_lost"
  }
  logEvent("delivery.outcome", {
    outboxId: row.id,
    eventId: row.event_id,
    state,
    code,
    attempts,
    fence: job.lease.fence,
  })
  return "sent"
}

export async function runDelivery(job: JobContext): Promise<void> {
  // Email off (flag, binding, keys or sender missing): nothing is created
  // or sent; rows already queued stay pending until mail is back.
  if (!emailCapability(job.env)) {
    if (featureOn(job.env.FEATURE_EMAIL))
      logEvent("delivery.unavailable", { fence: job.lease.fence })
    return
  }
  const clock = jobClock(job)
  await recoverAbandoned(job)
  await fanOutEvents(job)
  const claimed = await claim(job)
  for (let index = 0; index < claimed.length; index += 1) {
    const row = claimed[index]
    if (!row) continue
    const now = clock()
    if (now > job.lease.expiresAtMs - LEASE_SAFETY_MS) {
      await releaseUnstarted(
        job,
        claimed.slice(index).map((rest) => rest.id),
        now
      )
      logEvent("delivery.lease_budget", {
        remaining: claimed.length - index,
        fence: job.lease.fence,
      })
      return
    }
    // Every write uses the lease-relative clock so a lease that expires
    // during a slow provider call is detected before the outcome is recorded.
    const result = await deliverOne(job, row, clock)
    if (result === "lease_lost") return
  }
}
