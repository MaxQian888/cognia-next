/**
 * Subscriber rows: lookup by HMAC index (current key first, older keys for
 * rotation), preference views and the masked address.
 */

import type {
  ComponentId,
  StatusLocale,
  SubscriptionPreferences,
} from "../../../../../lib/status/contract"
import { parseJsonColumn } from "../incidents/ids"
import type { SubscriberRef } from "../notifications/outbox"
import { maskEmail } from "./email"
import { decryptEmail, type KeyRing } from "./keys"

export type SubscriberState = "pending" | "confirmed" | "unsubscribed" | "suppressed"

export interface SubscriberRow {
  id: string
  email_hmac: string
  email_hmac_key_id: string
  email_ciphertext: string | null
  email_key_id: string | null
  state: SubscriberState
  locale: StatusLocale
  component_ids_json: string
  consent_version: number
  consent_terms_version: number
  preference_revision: number
  created_at: number
  pending_since: number | null
  confirmed_at: number | null
  updated_at: number
  last_confirmation_sent_at: number | null
  suppressed_reason: string | null
  purge_after: number | null
  write_token: string | null
}

export const SUBSCRIBER_COLUMNS = `id, email_hmac, email_hmac_key_id, email_ciphertext, email_key_id, state, locale,
  component_ids_json, consent_version, consent_terms_version, preference_revision, created_at, pending_since,
  confirmed_at, updated_at, last_confirmation_sent_at, suppressed_reason, purge_after, write_token`

export async function readSubscriber(db: D1Database, id: string): Promise<SubscriberRow | null> {
  return db
    .prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE id = ?`)
    .bind(id)
    .first<SubscriberRow>()
}

/** Find the subscriber for an address under any configured HMAC key. */
export async function findSubscriberByHmacs(
  db: D1Database,
  hmacs: ReadonlyArray<{ keyId: string; hmac: string }>
): Promise<SubscriberRow | null> {
  if (hmacs.length === 0) return null
  const result = await db
    .prepare(
      `SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE email_hmac IN (${hmacs.map(() => "?").join(", ")}) LIMIT 2`
    )
    .bind(...hmacs.map((entry) => entry.hmac))
    .all<SubscriberRow>()
  // Prefer the row indexed under the current key (first in `hmacs`).
  for (const entry of hmacs) {
    const match = result.results.find(
      (row) => row.email_hmac === entry.hmac && row.email_hmac_key_id === entry.keyId
    )
    if (match) return match
  }
  return null
}

export function subscriberRef(row: SubscriberRow): SubscriberRef {
  return {
    id: row.id,
    locale: row.locale,
    consentVersion: row.consent_version,
    preferenceRevision: row.preference_revision,
  }
}

export function componentIdsOf(row: Pick<SubscriberRow, "component_ids_json">): ComponentId[] {
  return parseJsonColumn<ComponentId[]>(row.component_ids_json, "subscribers.component_ids_json")
}

/** The subscriber's address, or null when it cannot be decrypted. */
export async function subscriberEmail(
  encRing: KeyRing,
  row: SubscriberRow
): Promise<string | null> {
  if (!row.email_ciphertext || !row.email_key_id) return null
  return decryptEmail(encRing, row.id, row.email_key_id, row.email_ciphertext)
}

export async function preferencesOf(
  encRing: KeyRing,
  row: SubscriberRow
): Promise<SubscriptionPreferences | null> {
  const email = await subscriberEmail(encRing, row)
  if (!email) return null
  return {
    locale: row.locale,
    componentIds: componentIdsOf(row),
    maskedEmail: maskEmail(email),
    revision: row.preference_revision,
  }
}

export function subscriberTokenGuard(
  id: string,
  writeToken: string
): { sql: string; params: unknown[] } {
  return {
    sql: "EXISTS (SELECT 1 FROM subscribers WHERE id = ? AND write_token = ?)",
    params: [id, writeToken],
  }
}
