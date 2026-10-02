/**
 * Anonymous subscription writes (plan §10). POST only: a GET (a mail
 * scanner following a link) is 405 and never changes consent; tokens arrive
 * in POST bodies from the status page, which reads them from the URL
 * fragment. Every POST must carry an allowed `Origin` (exact match); there
 * is no CORS on these routes, the primary page is same-origin.
 *
 * - `POST /subscriptions`: always the same 202 `{status:"accepted"}` for a
 *   new, pending, confirmed, unsubscribed or suppressed address, so the
 *   response never reveals whether an address is known. A confirmed address
 *   keeps its preferences; it is sent a manage link instead (same cooldown
 *   and budget as confirmations). An unsubscribed address starts a fresh
 *   double opt-in. A suppressed address is sent nothing.
 * - `POST /subscriptions/confirm`: one confirm token confirms its pending
 *   subscriber once; retrying the same token afterwards returns the same
 *   result. Expired → 410 `token_expired`; unknown, malformed or another
 *   purpose → 400 `token_invalid`; used while the subscription has since
 *   ended → 410 `token_used`.
 * - `POST /subscriptions/manage`: a manage token reads or updates its own
 *   subscriber's locale/components; updates name the expected preference
 *   revision (409 on mismatch). Manage tokens are bound to the consent
 *   version they were minted under; a preference change does not revoke
 *   them (each mail carries a fresh one), unsubscribing does.
 * - `POST /subscriptions/unsubscribe`: takes the same manage-purpose token
 *   the mail's unsubscribe link carries (one token per message). Idempotent;
 *   bumps the consent version (revoking every manage token and making every
 *   queued row fail its consent re-check), cancels unsent rows and schedules
 *   the address for purge after 30 days.
 */

import {
  DAY_MS,
  SUBSCRIPTION_CONSENT_VERSION,
  type ConfirmResult,
  type ManageResult,
  type StatusErrorCode,
  type SubscribeAccepted,
  type UnsubscribeResult,
} from "../../../../../lib/status/contract"
import {
  parseManageRequest,
  parseSubscribeRequest,
  parseTokenRequest,
} from "../../../../../lib/status/validate"
import type { Env } from "../env"
import { newWriteToken, randomId, relativeApiPath } from "../incidents/ids"
import { committed } from "../incidents/store"
import { hashToken, subscriberMailStatements, type SubscriberRef } from "../notifications/outbox"
import { errorResponse, json, logEvent, readJsonBody, type RequestContext } from "../platform/http"
import type { RouteHandler } from "../seams"
import { allowedOrigins, emailCapability } from "./capability"
import { normalizeEmail } from "./email"
import { emailHmacs, encKeyRing, encryptEmail, hmacKeyRing, type KeyRing } from "./keys"
import { EMAIL_COOLDOWN_MS, reserveGlobalConfirmation, takeIpAttempt } from "./rate"
import {
  SUBSCRIBER_COLUMNS,
  findSubscriberByHmacs,
  preferencesOf,
  readSubscriber,
  subscriberRef,
  subscriberTokenGuard,
  type SubscriberRow,
} from "./store"

/** Unsubscribed addresses are purged this long after unsubscribing. */
export const UNSUBSCRIBE_PURGE_MS = 30 * DAY_MS

type Action = "subscribe" | "confirm" | "manage" | "unsubscribe"

const PATHS: Record<string, Action> = {
  "/subscriptions": "subscribe",
  "/subscriptions/confirm": "confirm",
  "/subscriptions/manage": "manage",
  "/subscriptions/unsubscribe": "unsubscribe",
}

export interface TokenRow {
  token_hash: string
  subscriber_id: string
  purpose: "confirm" | "manage"
  consent_version: number
  preference_revision: number
  created_at: number
  expires_at: number
  used_at: number | null
}

function fail(code: StatusErrorCode, ctx: RequestContext, currentRevision?: number): Response {
  return errorResponse(code, ctx, currentRevision === undefined ? {} : { currentRevision })
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin")
  return origin !== null && allowedOrigins(env).includes(origin)
}

async function readToken(db: D1Database, token: string): Promise<TokenRow | null> {
  return db
    .prepare(
      `SELECT token_hash, subscriber_id, purpose, consent_version, preference_revision, created_at, expires_at, used_at
       FROM subscriber_tokens WHERE token_hash = ?`
    )
    .bind(await hashToken(token))
    .first<TokenRow>()
}

// ---------------------------------------------------------------------------
// POST /subscriptions
// ---------------------------------------------------------------------------

const ACCEPTED: SubscribeAccepted = { status: "accepted" }

function accepted(): Response {
  return json(ACCEPTED, { status: 202 })
}

interface SignupContext {
  env: Env
  nowMs: number
  email: string
  locale: SubscriberRow["locale"]
  componentIds: string[]
  termsVersion: number
  hmacRing: KeyRing
  encRing: KeyRing
}

/** Whether to send a confirmation-type mail now: per-address cooldown, then the global budget. */
async function mayMail(signup: SignupContext, lastSentAt: number | null): Promise<boolean> {
  if (lastSentAt !== null && lastSentAt > signup.nowMs - EMAIL_COOLDOWN_MS) return false
  return reserveGlobalConfirmation(signup.env, signup.nowMs)
}

async function signupNew(
  signup: SignupContext,
  hmac: { keyId: string; hmac: string }
): Promise<string> {
  const db = signup.env.DB
  const id = randomId("sub")
  const writeToken = newWriteToken()
  const sealed = await encryptEmail(signup.encRing, id, signup.email)
  const sendMail = await mayMail(signup, null)
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO subscribers (${SUBSCRIBER_COLUMNS})
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, 0, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
      )
      .bind(
        id,
        hmac.hmac,
        hmac.keyId,
        sealed.ciphertext,
        sealed.keyId,
        signup.locale,
        JSON.stringify(signup.componentIds),
        signup.termsVersion,
        signup.nowMs,
        signup.nowMs,
        signup.nowMs,
        sendMail ? signup.nowMs : null,
        writeToken
      ),
  ]
  if (sendMail) {
    const ref: SubscriberRef = {
      id,
      locale: signup.locale,
      consentVersion: 1,
      preferenceRevision: 0,
    }
    statements.push(
      ...(await subscriberMailStatements(
        db,
        signup.env,
        { subscriber: ref, purpose: "confirmation", nowMs: signup.nowMs },
        subscriberTokenGuard(id, writeToken)
      ))
    )
  }
  // A concurrent signup for the same address wins the unique index; this
  // one then inserts nothing and its guarded mail statements do nothing.
  const results = await db.batch(statements)
  return committed(results) ? (sendMail ? "new_mailed" : "new_unmailed") : "new_raced"
}

async function signupExisting(
  signup: SignupContext,
  row: SubscriberRow,
  hmac: { keyId: string; hmac: string }
): Promise<string> {
  const db = signup.env.DB
  if (row.state === "suppressed") return "suppressed"
  const writeToken = newWriteToken()
  const sendMail = await mayMail(signup, row.last_confirmation_sent_at)
  // Touching the row re-indexes and re-encrypts it under the current keys.
  const sealed = await encryptEmail(signup.encRing, row.id, signup.email)
  const sentAt = sendMail ? signup.nowMs : row.last_confirmation_sent_at
  let update: D1PreparedStatement
  let purpose: "confirmation" | "manage_link"
  let nextRef: SubscriberRef
  if (row.state === "confirmed") {
    if (!sendMail) return "confirmed_quiet"
    // Preferences of a confirmed subscriber never change through signup.
    update = db
      .prepare(
        `UPDATE subscribers SET email_hmac = ?, email_hmac_key_id = ?, email_ciphertext = ?, email_key_id = ?,
           last_confirmation_sent_at = ?, updated_at = ?, write_token = ?
         WHERE id = ? AND state = 'confirmed' AND consent_version = ?
           AND (last_confirmation_sent_at IS NULL OR last_confirmation_sent_at <= ?)`
      )
      .bind(
        hmac.hmac,
        hmac.keyId,
        sealed.ciphertext,
        sealed.keyId,
        sentAt,
        signup.nowMs,
        writeToken,
        row.id,
        row.consent_version,
        signup.nowMs - EMAIL_COOLDOWN_MS
      )
    purpose = "manage_link"
    nextRef = subscriberRef(row)
  } else {
    // pending (refresh preferences and, outside the cooldown, resend) or
    // unsubscribed (a fresh double opt-in under the bumped consent version).
    update = db
      .prepare(
        `UPDATE subscribers SET state = 'pending', email_hmac = ?, email_hmac_key_id = ?, email_ciphertext = ?,
           email_key_id = ?, locale = ?, component_ids_json = ?, consent_terms_version = ?,
           pending_since = CASE WHEN ? = 1 OR state != 'pending' THEN ? ELSE pending_since END,
           purge_after = NULL, last_confirmation_sent_at = ?, updated_at = ?, write_token = ?
         WHERE id = ? AND state = ? AND consent_version = ?
           AND (? = 0 OR last_confirmation_sent_at IS NULL OR last_confirmation_sent_at <= ?)`
      )
      .bind(
        hmac.hmac,
        hmac.keyId,
        sealed.ciphertext,
        sealed.keyId,
        signup.locale,
        JSON.stringify(signup.componentIds),
        signup.termsVersion,
        sendMail ? 1 : 0,
        signup.nowMs,
        sentAt,
        signup.nowMs,
        writeToken,
        row.id,
        row.state,
        row.consent_version,
        sendMail ? 1 : 0,
        signup.nowMs - EMAIL_COOLDOWN_MS
      )
    purpose = "confirmation"
    nextRef = {
      id: row.id,
      locale: signup.locale,
      consentVersion: row.consent_version,
      preferenceRevision: row.preference_revision,
    }
  }
  const statements = [update]
  if (sendMail) {
    statements.push(
      ...(await subscriberMailStatements(
        db,
        signup.env,
        { subscriber: nextRef, purpose, nowMs: signup.nowMs },
        subscriberTokenGuard(row.id, writeToken)
      ))
    )
  }
  const results = await db.batch(statements)
  return `${row.state}_${committed(results) ? (sendMail ? "mailed" : "updated") : "raced"}`
}

async function subscribe(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (!emailCapability(env)) return fail("unavailable", ctx)
  const hmacRing = hmacKeyRing(env)
  const encRing = encKeyRing(env)
  if (!hmacRing || !encRing) return fail("unavailable", ctx)
  if (!(await takeIpAttempt(env, request, ctx.nowMs))) return fail("rate_limited", ctx)
  const body = await readJsonBody(request)
  if (!body.ok) return fail(body.code, ctx)
  const parsed = parseSubscribeRequest(body.value)
  if (!parsed.ok || parsed.value.consentVersion !== SUBSCRIPTION_CONSENT_VERSION)
    return fail("bad_request", ctx)
  const email = normalizeEmail(parsed.value.email)
  if (!email) return fail("bad_request", ctx)

  const signup: SignupContext = {
    env,
    nowMs: ctx.nowMs,
    email,
    locale: parsed.value.locale,
    componentIds: parsed.value.componentIds,
    termsVersion: parsed.value.consentVersion,
    hmacRing,
    encRing,
  }
  const hmacs = await emailHmacs(hmacRing, email)
  const current = hmacs[0]
  if (!current) return fail("unavailable", ctx)
  const existing = await findSubscriberByHmacs(env.DB, hmacs)
  const outcome = existing
    ? await signupExisting(signup, existing, current)
    : await signupNew(signup, current)
  // The outcome is for operators only; the client always gets the same body.
  logEvent("subscription.signup", { requestId: ctx.requestId, outcome })
  return accepted()
}

// ---------------------------------------------------------------------------
// POST /subscriptions/confirm
// ---------------------------------------------------------------------------

async function confirmResponse(
  encRing: KeyRing,
  row: SubscriberRow,
  ctx: RequestContext
): Promise<Response> {
  const preferences = await preferencesOf(encRing, row)
  if (!preferences) return fail("internal", ctx)
  const result: ConfirmResult = { status: "confirmed", preferences }
  return json(result)
}

async function confirm(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const encRing = encKeyRing(env)
  if (!encRing) return fail("unavailable", ctx)
  const body = await readJsonBody(request)
  if (!body.ok) return fail(body.code, ctx)
  const parsed = parseTokenRequest(body.value)
  if (!parsed.ok) return fail("token_invalid", ctx)
  const db = env.DB

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await readToken(db, parsed.value.token)
    if (!token || token.purpose !== "confirm") return fail("token_invalid", ctx)
    const row = await readSubscriber(db, token.subscriber_id)
    if (!row) return fail("token_invalid", ctx)

    if (row.state === "confirmed" && row.consent_version === token.consent_version) {
      // Idempotent: the same (or a sibling) confirmation link after success.
      if (token.used_at === null) {
        await db
          .prepare(
            "UPDATE subscriber_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
          )
          .bind(ctx.nowMs, token.token_hash)
          .run()
      }
      return confirmResponse(encRing, row, ctx)
    }
    if (token.used_at !== null) return fail("token_used", ctx)
    if (token.expires_at <= ctx.nowMs) return fail("token_expired", ctx)
    if (row.state !== "pending" || row.consent_version !== token.consent_version)
      return fail("token_invalid", ctx)

    const writeToken = newWriteToken()
    const guard = subscriberTokenGuard(row.id, writeToken)
    const confirmedRow: SubscriberRow = {
      ...row,
      state: "confirmed",
      confirmed_at: ctx.nowMs,
      pending_since: null,
      preference_revision: row.preference_revision + 1,
      updated_at: ctx.nowMs,
      write_token: writeToken,
    }
    const statements = [
      db
        .prepare(
          `UPDATE subscribers SET state = 'confirmed', confirmed_at = ?, pending_since = NULL,
             preference_revision = preference_revision + 1, updated_at = ?, write_token = ?
           WHERE id = ? AND state = 'pending' AND consent_version = ?`
        )
        .bind(ctx.nowMs, ctx.nowMs, writeToken, row.id, row.consent_version),
      db
        .prepare(
          `UPDATE subscriber_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND ${guard.sql}`
        )
        .bind(ctx.nowMs, token.token_hash, ...guard.params),
    ]
    // The welcome mail carries the subscriber's first manage/unsubscribe
    // links. With email off the confirmation still stands; links come with
    // the next mail once delivery is back.
    if (emailCapability(env)) {
      statements.push(
        ...(await subscriberMailStatements(
          db,
          env,
          { subscriber: subscriberRef(confirmedRow), purpose: "welcome", nowMs: ctx.nowMs },
          guard
        ))
      )
    }
    if (committed(await db.batch(statements))) {
      logEvent("subscription.confirmed", { requestId: ctx.requestId })
      return confirmResponse(encRing, confirmedRow, ctx)
    }
    // Lost a race (a concurrent confirm): re-read once and answer from the
    // committed state.
  }
  return fail("conflict", ctx)
}

// ---------------------------------------------------------------------------
// POST /subscriptions/manage
// ---------------------------------------------------------------------------

async function manage(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const encRing = encKeyRing(env)
  if (!encRing) return fail("unavailable", ctx)
  const body = await readJsonBody(request)
  if (!body.ok) return fail(body.code, ctx)
  const parsed = parseManageRequest(body.value)
  if (!parsed.ok)
    return fail(parseTokenRequest(body.value).ok ? "bad_request" : "token_invalid", ctx)
  const db = env.DB
  const token = await readToken(db, parsed.value.token)
  if (!token || token.purpose !== "manage") return fail("token_invalid", ctx)
  if (token.expires_at <= ctx.nowMs) return fail("token_expired", ctx)
  const row = await readSubscriber(db, token.subscriber_id)
  if (!row || row.state !== "confirmed" || row.consent_version !== token.consent_version) {
    return fail("token_invalid", ctx)
  }

  let current = row
  if (parsed.value.operation === "update") {
    const update = parsed.value
    if (update.expectedRevision !== row.preference_revision) {
      return fail("revision_conflict", ctx, row.preference_revision)
    }
    const result = await db
      .prepare(
        `UPDATE subscribers SET locale = ?, component_ids_json = ?, preference_revision = preference_revision + 1,
           updated_at = ?, write_token = ?
         WHERE id = ? AND state = 'confirmed' AND consent_version = ? AND preference_revision = ?`
      )
      .bind(
        update.locale,
        JSON.stringify(update.componentIds),
        ctx.nowMs,
        newWriteToken(),
        row.id,
        row.consent_version,
        update.expectedRevision
      )
      .run()
    if (result.meta.changes !== 1) {
      const latest = await readSubscriber(db, row.id)
      if (
        !latest ||
        latest.state !== "confirmed" ||
        latest.consent_version !== token.consent_version
      ) {
        return fail("token_invalid", ctx)
      }
      return fail("revision_conflict", ctx, latest.preference_revision)
    }
    current = {
      ...row,
      locale: update.locale,
      component_ids_json: JSON.stringify(update.componentIds),
      preference_revision: row.preference_revision + 1,
    }
    logEvent("subscription.preferences_updated", { requestId: ctx.requestId })
  }
  const preferences = await preferencesOf(encRing, current)
  if (!preferences) return fail("internal", ctx)
  const result: ManageResult = { status: "ok", preferences }
  return json(result)
}

// ---------------------------------------------------------------------------
// POST /subscriptions/unsubscribe
// ---------------------------------------------------------------------------

const UNSUBSCRIBED: UnsubscribeResult = { status: "unsubscribed" }

async function unsubscribe(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return fail(body.code, ctx)
  const parsed = parseTokenRequest(body.value)
  if (!parsed.ok) return fail("token_invalid", ctx)
  const db = env.DB
  const token = await readToken(db, parsed.value.token)
  if (!token || token.purpose !== "manage") return fail("token_invalid", ctx)
  if (token.expires_at <= ctx.nowMs) return fail("token_expired", ctx)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await readSubscriber(db, token.subscriber_id)
    if (!row) return fail("token_invalid", ctx)
    // Already ended: idempotent success for the holder of a link to it.
    if (row.state === "unsubscribed" || row.state === "suppressed") return json(UNSUBSCRIBED)
    // A newer opt-in (or a token from an older cycle) is not this link's to end.
    if (row.state !== "confirmed" || row.consent_version !== token.consent_version)
      return fail("token_invalid", ctx)

    const writeToken = newWriteToken()
    const guard = subscriberTokenGuard(row.id, writeToken)
    const results = await db.batch([
      db
        .prepare(
          `UPDATE subscribers SET state = 'unsubscribed', consent_version = consent_version + 1,
             purge_after = ?, updated_at = ?, write_token = ?
           WHERE id = ? AND state = 'confirmed' AND consent_version = ?`
        )
        .bind(ctx.nowMs + UNSUBSCRIBE_PURGE_MS, ctx.nowMs, writeToken, row.id, row.consent_version),
      // Unsent rows are cancelled. A leased row whose provider call has not
      // started is cancelled too; one whose call already started cannot be
      // recalled (see notifications/delivery.ts for the exact cutoff).
      db
        .prepare(
          `UPDATE outbox SET state = 'cancelled', last_error_code = 'unsubscribed', updated_at = ?
           WHERE subscriber_id = ?
             AND (state IN ('pending', 'retryable_failure') OR (state = 'leased' AND attempt_started_at IS NULL))
             AND ${guard.sql}`
        )
        .bind(ctx.nowMs, row.id, ...guard.params),
    ])
    if (committed(results)) {
      logEvent("subscription.unsubscribed", {
        requestId: ctx.requestId,
        cancelled: results[1]?.meta.changes ?? 0,
      })
      return json(UNSUBSCRIBED)
    }
  }
  return fail("conflict", ctx)
}

export const handleSubscriptionRoutes: RouteHandler = async (request, env, ctx) => {
  const path = relativeApiPath(ctx.url)
  if (path === null) return null
  const action = PATHS[path]
  if (!action) return null
  // Link scanners and prefetchers issue GETs: never a state change.
  if (request.method !== "POST")
    return errorResponse("method_not_allowed", ctx, { headers: { allow: "POST" } })
  if (!originAllowed(request, env)) return fail("forbidden", ctx)
  switch (action) {
    case "subscribe":
      return subscribe(request, env, ctx)
    case "confirm":
      return confirm(request, env, ctx)
    case "manage":
      return manage(request, env, ctx)
    case "unsubscribe":
      return unsubscribe(request, env, ctx)
  }
}
