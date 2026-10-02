/**
 * Send-outcome classification and the retry schedule for Cloudflare Email
 * Sending (the `EMAIL` `send_email` binding).
 *
 * The binding offers no idempotency key and no delivery/bounce webhook, so:
 * - success is `provider_accepted` with the provider message ID, never
 *   "delivered": nothing tells us the mail reached the inbox;
 * - `E_RECIPIENT_SUPPRESSED` is the provider's own suppression list and
 *   replaces bounce/complaint handling: the subscriber is suppressed;
 * - rate/daily limits mean the provider refused the message, so a retry is
 *   safe: `retryable_failure` with backoff;
 * - validation, sender, header and size errors will fail the same way
 *   again: `terminal_failure`;
 * - `E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR`, an error without a code,
 *   any unrecognised code and a timeout leave it unknown whether the
 *   provider accepted the message: `uncertain`. An uncertain row is never
 *   retried automatically (a retry could send it twice); an operator checks
 *   provider evidence and retries it deliberately with
 *   `acknowledgeUncertain: true`, which is audited.
 */

import { HOUR_MS, MINUTE_MS } from "../../../../../lib/status/contract"

export type SendOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "retryable"; code: string }
  | { kind: "terminal"; code: string }
  | { kind: "suppressed"; code: string }
  | { kind: "uncertain"; code: string }

const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"])
const TERMINAL = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_CONTENT_TOO_LARGE",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
])
const UNCERTAIN = new Set(["E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"])

/** Our own timeout marker; the provider call may still have succeeded. */
export const TIMEOUT_CODE = "timeout"

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code
  }
  return null
}

export function classifySendError(error: unknown): SendOutcome {
  const code = errorCode(error)
  if (code === null) return { kind: "uncertain", code: "no_code" }
  if (code === "E_RECIPIENT_SUPPRESSED") return { kind: "suppressed", code }
  if (RETRYABLE.has(code)) return { kind: "retryable", code }
  if (TERMINAL.has(code) || code.startsWith("E_HEADER_")) return { kind: "terminal", code }
  if (UNCERTAIN.has(code)) return { kind: "uncertain", code }
  return { kind: "uncertain", code }
}

/** Backoff after the 1st, 2nd, 3rd and 4th failed attempt. */
export const RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS] as const
/** Then every 6 h… */
export const RETRY_REPEAT_MS = 6 * HOUR_MS
/** …until 24 h after the row was created. */
export const RETRY_WINDOW_MS = 24 * HOUR_MS
export const RETRY_JITTER = 0.2

/**
 * When to try again after `attempts` failed attempts, or null when the next
 * attempt would fall outside the 24 h window (the row becomes terminal).
 * `random` in [0, 1) gives ±20 % jitter.
 */
export function nextRetryAt(
  attempts: number,
  createdAtMs: number,
  nowMs: number,
  random: number
): number | null {
  const base = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_REPEAT_MS
  const jitter = 1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.min(Math.max(random, 0), 1)
  const at = nowMs + Math.round(base * jitter)
  return at <= createdAtMs + RETRY_WINDOW_MS ? at : null
}
