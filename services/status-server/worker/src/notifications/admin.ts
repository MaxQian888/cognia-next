/**
 * Operator delivery inspection and deliberate retry.
 *
 * Views never include a recipient, subject or body. A retry applies only
 * to `uncertain`, `terminal_failure` and `retryable_failure` rows. An
 * `uncertain` row may already have been accepted by the provider (there is
 * no idempotency key), so retrying it requires `acknowledgeUncertain: true`
 * — the operator's statement that they checked the provider's evidence —
 * and the retry is audited with that acknowledgement. The retried row goes
 * back to `pending` and passes the normal consent re-check before sending.
 */

import {
  STATUS_SCHEMA_VERSION,
  type DeliveryRetryRequest,
  type DeliveryState,
  type DeliveryView,
} from "../../../../../lib/status/contract"
import { toIso } from "../../../../../lib/status/derive"
import { planError, type MutationPlan, type OperatorContext } from "../admin/mutation"
import { newWriteToken } from "../incidents/ids"

export const DELIVERY_STATES: readonly DeliveryState[] = [
  "pending",
  "leased",
  "provider_accepted",
  "retryable_failure",
  "terminal_failure",
  "uncertain",
  "suppressed",
  "cancelled",
]
export const MAX_DELIVERY_LIST = 100
export const DEFAULT_DELIVERY_LIST = 50
const RETRYABLE_BY_OPERATOR: readonly DeliveryState[] = [
  "uncertain",
  "terminal_failure",
  "retryable_failure",
]

interface DeliveryRow {
  id: string
  event_id: string
  state: DeliveryState
  attempts: number
  next_attempt_at: number | null
  last_error_code: string | null
  provider_message_id: string | null
  created_at: number
  updated_at: number
  text_body: string | null
}

const COLUMNS = `id, event_id, state, attempts, next_attempt_at, last_error_code, provider_message_id, created_at,
  updated_at, text_body`

export function toDeliveryView(row: DeliveryRow): DeliveryView {
  return {
    id: row.id,
    eventId: row.event_id,
    channel: "email",
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at === null ? null : toIso(row.next_attempt_at),
    lastErrorCode: row.last_error_code,
    providerMessageId: row.provider_message_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export function parseDeliveryQuery(
  url: URL
): { state: DeliveryState | null; limit: number } | null {
  const rawState = url.searchParams.get("state")
  const rawLimit = url.searchParams.get("limit")
  let state: DeliveryState | null = null
  if (rawState !== null && rawState !== "") {
    if (!(DELIVERY_STATES as readonly string[]).includes(rawState)) return null
    state = rawState as DeliveryState
  }
  let limit = DEFAULT_DELIVERY_LIST
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d{1,3}$/.test(rawLimit)) return null
    limit = Number(rawLimit)
    if (limit < 1 || limit > MAX_DELIVERY_LIST) return null
  }
  return { state, limit }
}

export async function listDeliveries(
  db: D1Database,
  query: { state: DeliveryState | null; limit: number }
): Promise<{ schemaVersion: 1; deliveries: DeliveryView[] }> {
  const result = query.state
    ? await db
        .prepare(
          `SELECT ${COLUMNS} FROM outbox WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ?`
        )
        .bind(query.state, query.limit)
        .all<DeliveryRow>()
    : await db
        .prepare(`SELECT ${COLUMNS} FROM outbox ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .bind(query.limit)
        .all<DeliveryRow>()
  return { schemaVersion: STATUS_SCHEMA_VERSION, deliveries: result.results.map(toDeliveryView) }
}

export async function planDeliveryRetry(
  db: D1Database,
  request: DeliveryRetryRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM outbox WHERE id = ?`)
    .bind(request.outboxId)
    .first<DeliveryRow>()
  if (!row) return planError("not_found")
  if (!RETRYABLE_BY_OPERATOR.includes(row.state)) return planError("conflict")
  if (row.state === "uncertain" && !request.acknowledgeUncertain) return planError("bad_request")
  // Bodies are cleared a day after a row finished; such a row cannot be resent.
  if (row.text_body === null) return planError("conflict")
  const writeToken = newWriteToken()
  const cas = db
    .prepare(
      `UPDATE outbox SET state = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_fence = NULL,
         attempt_started_at = NULL, updated_at = ?, write_token = ?
       WHERE id = ? AND state = ?`
    )
    .bind(operator.nowMs, operator.nowMs, writeToken, row.id, row.state)
  const predicted: DeliveryView = toDeliveryView({
    ...row,
    state: "pending",
    next_attempt_at: operator.nowMs,
    updated_at: operator.nowMs,
  })
  return {
    kind: "write",
    statements: [cas],
    guard: {
      sql: "EXISTS (SELECT 1 FROM outbox WHERE id = ? AND write_token = ?)",
      params: [row.id, writeToken],
    },
    result: { status: 200, body: { schemaVersion: STATUS_SCHEMA_VERSION, delivery: predicted } },
    audit: {
      action: "delivery.retry",
      targetType: "outbox",
      targetId: row.id,
      revision: null,
      detail: {
        previousState: row.state,
        attempts: row.attempts,
        lastErrorCode: row.last_error_code,
        acknowledgeUncertain: request.acknowledgeUncertain,
      },
    },
    onLostRace: async () => planError("conflict"),
  }
}
