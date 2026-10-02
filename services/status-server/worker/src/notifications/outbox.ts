/**
 * Outbox row creation.
 *
 * A row is the immutable message for one (subscriber, event, channel,
 * consent version): the rendered subject/bodies, their digest and the
 * delivery state. The unique key makes creation idempotent, so a crashed
 * or replayed fan-out never produces a second row. A row stores no address:
 * delivery decrypts it from the subscriber row at send time, after the
 * consent re-check.
 *
 * Mail that carries management links mints a fresh manage token for that
 * message (only its hash is stored). The token insert is conditional on the
 * row not existing yet, so a replayed fan-out mints nothing extra.
 */

import { DAY_MS, type StatusLocale } from "../../../../../lib/status/contract"
import { statusIncidentPageUrl, statusTokenPageUrl } from "../../../../../lib/status/config"
import { sha256Hex } from "../../../../../lib/status/signing"
import type { WriteGuard } from "../admin/mutation"
import type { Env } from "../env"
import { randomId, randomToken } from "../incidents/ids"
import {
  guardedEventStatement,
  type IncidentEventPayload,
  type MaintenanceEventPayload,
} from "./events"
import {
  renderConfirmationMail,
  renderIncidentMail,
  renderMaintenanceMail,
  renderWelcomeMail,
  type MailLinks,
  type RenderedMail,
} from "./render"

/** Confirmation links (and the pending entry) live for 24 hours. */
export const CONFIRM_TOKEN_TTL_MS = DAY_MS
/**
 * Manage / unsubscribe links are long-lived but bound to the consent version
 * they were minted under: unsubscribing invalidates every one of them.
 */
export const MANAGE_TOKEN_TTL_MS = 180 * DAY_MS

export type OutboxPurpose = "notification" | "confirmation" | "welcome" | "manage_link"

export interface SubscriberRef {
  id: string
  locale: StatusLocale
  consentVersion: number
  preferenceRevision: number
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token))
}

async function payloadDigest(mail: RenderedMail): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(`${mail.subject}\n\u0000${mail.text}\n\u0000${mail.html}`)
  )
}

function combine(...guards: WriteGuard[]): WriteGuard {
  return {
    sql: guards.map((guard) => guard.sql).join(" AND "),
    params: guards.flatMap((guard) => guard.params),
  }
}

export async function tokenInsertStatement(
  db: D1Database,
  input: { subscriber: SubscriberRef; purpose: "confirm" | "manage"; token: string; nowMs: number },
  guard: WriteGuard
): Promise<D1PreparedStatement> {
  const ttl = input.purpose === "confirm" ? CONFIRM_TOKEN_TTL_MS : MANAGE_TOKEN_TTL_MS
  return db
    .prepare(
      `INSERT INTO subscriber_tokens (token_hash, subscriber_id, purpose, consent_version, preference_revision,
         created_at, expires_at, used_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${guard.sql}`
    )
    .bind(
      await hashToken(input.token),
      input.subscriber.id,
      input.purpose,
      input.subscriber.consentVersion,
      input.subscriber.preferenceRevision,
      input.nowMs,
      input.nowMs + ttl,
      ...guard.params
    )
}

async function outboxInsert(
  db: D1Database,
  input: {
    subscriber: SubscriberRef
    eventId: string
    purpose: OutboxPurpose
    mail: RenderedMail
    nowMs: number
  },
  guard: WriteGuard
): Promise<D1PreparedStatement> {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, subscriber_id, event_id, channel, purpose, consent_version, state, attempts,
         next_attempt_at, lease_owner, lease_fence, attempt_started_at, provider_message_id, subject, text_body,
         html_body, payload_digest, last_error_code, created_at, updated_at, write_token)
       SELECT ?, ?, ?, 'email', ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL
       WHERE ${guard.sql}`
    )
    .bind(
      randomId("out"),
      input.subscriber.id,
      input.eventId,
      input.purpose,
      input.subscriber.consentVersion,
      input.nowMs,
      input.mail.subject,
      input.mail.text,
      input.mail.html,
      await payloadDigest(input.mail),
      input.nowMs,
      input.nowMs,
      ...guard.params
    )
}

function manageLinks(env: Env, detailUrl: string, manageToken: string): MailLinks {
  return {
    detailUrl,
    manageUrl: statusTokenPageUrl(env.PUBLIC_PAGE_URL, "manage", manageToken),
    // The unsubscribe link carries the same manage-purpose token: one
    // token per message, valid for both actions until consent changes.
    unsubscribeUrl: statusTokenPageUrl(env.PUBLIC_PAGE_URL, "unsubscribe", manageToken),
  }
}

/**
 * Statements for one transactional mail to one subscriber (confirmation,
 * welcome, manage link): token, event and outbox row, all conditional on
 * `guard` (the subscriber write that triggered it committed).
 */
export async function subscriberMailStatements(
  db: D1Database,
  env: Env,
  input: {
    subscriber: SubscriberRef
    purpose: Exclude<OutboxPurpose, "notification">
    nowMs: number
  },
  guard: WriteGuard
): Promise<D1PreparedStatement[]> {
  const token = randomToken()
  const eventId = `subscriber:${input.subscriber.id}:${input.purpose}:${randomId("m").slice(2, 18)}`
  const mail =
    input.purpose === "confirmation"
      ? renderConfirmationMail(
          input.subscriber.locale,
          statusTokenPageUrl(env.PUBLIC_PAGE_URL, "confirm", token)
        )
      : renderWelcomeMail(
          input.subscriber.locale,
          manageLinks(env, env.PUBLIC_PAGE_URL, token),
          input.purpose
        )
  return [
    await tokenInsertStatement(
      db,
      {
        subscriber: input.subscriber,
        purpose: input.purpose === "confirmation" ? "confirm" : "manage",
        token,
        nowMs: input.nowMs,
      },
      guard
    ),
    guardedEventStatement(
      db,
      {
        id: eventId,
        payload: {
          type: "subscriber",
          purpose: input.purpose,
          subscriberId: input.subscriber.id,
          atMs: input.nowMs,
        },
        createdAtMs: input.nowMs,
      },
      guard
    ),
    await outboxInsert(
      db,
      { subscriber: input.subscriber, eventId, purpose: input.purpose, mail, nowMs: input.nowMs },
      guard
    ),
  ]
}

/**
 * Statements creating one subscriber's row for a public event during
 * fan-out. `guard` is the delivery lease; the token insert additionally
 * requires that the row does not exist yet.
 */
export async function fanoutRowStatements(
  db: D1Database,
  env: Env,
  input: {
    eventId: string
    payload: IncidentEventPayload | MaintenanceEventPayload
    subscriber: SubscriberRef
    nowMs: number
  },
  guard: WriteGuard
): Promise<D1PreparedStatement[]> {
  const token = randomToken()
  const detailUrl =
    input.payload.type === "incident"
      ? statusIncidentPageUrl(env.PUBLIC_PAGE_URL, input.payload.incidentId)
      : env.PUBLIC_PAGE_URL
  const links = manageLinks(env, detailUrl, token)
  const mail =
    input.payload.type === "incident"
      ? renderIncidentMail(input.payload, input.subscriber.locale, links)
      : renderMaintenanceMail(input.payload, input.subscriber.locale, links)
  const notYetCreated: WriteGuard = {
    sql: `NOT EXISTS (SELECT 1 FROM outbox WHERE subscriber_id = ? AND event_id = ? AND channel = 'email'
           AND consent_version = ?)`,
    params: [input.subscriber.id, input.eventId, input.subscriber.consentVersion],
  }
  return [
    await tokenInsertStatement(
      db,
      { subscriber: input.subscriber, purpose: "manage", token, nowMs: input.nowMs },
      combine(guard, notYetCreated)
    ),
    await outboxInsert(
      db,
      {
        subscriber: input.subscriber,
        eventId: input.eventId,
        purpose: "notification",
        mail,
        nowMs: input.nowMs,
      },
      guard
    ),
  ]
}
