// Failure taxonomy for subscription quota / balance / refresh calls.
//
// The whole point of this module is one distinction the generic classifier in
// `@cognia/provider-routing/error-classifier` deliberately does not draw:
// "quota exceeded" and "too many requests per minute" both land in its
// `rate-limit` class, because for chat-routing purposes both mean "try another
// provider". For a SUBSCRIPTION account they are opposite instructions.
//
//   * A per-minute throttle clears on its own. Retry the same credential in
//     seconds. Rotating away from it wastes a healthy sibling.
//   * An account-local quota exhaustion lasts hours. Retrying the same
//     credential re-hits a block the server already told us about, and a client
//     that keeps doing that is what gets an account flagged. Rotate to a
//     sibling, and do not come back before the window the server named.
//
// So the split is made here first, and the generic classifier is consulted only
// for the message shapes it genuinely reads better (network, timeout, plain
// server errors). The pattern set below is the same one `oh-my-pi` arrived at
// after collecting real provider bodies, including the Simplified Chinese
// phrasing that Zhipu and other CN coding plans return.

import { classifyProviderErrorInfo } from "@cognia/provider-routing/error-classifier"

import { extractRetryHintMs, type RetryHintHeaders } from "./retry-hint"

/**
 * Why a subscription call failed, in the vocabulary the retry layer acts on.
 *
 * Ordered from "the credential is gone" to "we have no idea".
 */
export type SubscriptionFailureReason =
  /** Bearer is stale but the refresh token is still good. Refresh, do not rotate. */
  | "auth-expired"
  /** Refresh token revoked or the login was invalidated. Permanent until the user re-authenticates. */
  | "auth-revoked"
  /** Account-local quota window is spent. Rotate to a sibling, honor the reset. */
  | "account-quota"
  /** Prepaid credits or a billing cap are exhausted. Rotate, honor the reset. */
  | "billing-cap"
  /** Per-second or per-minute throttle. Short wait on the SAME credential. */
  | "throttled"
  /** Too many in-flight requests. Shed and retry shortly, never rotate. */
  | "concurrency"
  /** Model or service overloaded (503 / 529). Transient, jittered wait. */
  | "capacity"
  /** 5xx that is not a capacity signal. */
  | "server-error"
  /** Transport failure, no HTTP status reached us. */
  | "network"
  /** A 4xx we should not repeat, such as a malformed request. */
  | "client-error"
  /** Nothing in the response let us decide. Treated conservatively. */
  | "unknown"

export interface SubscriptionFailure {
  reason: SubscriptionFailureReason
  /** HTTP status when one reached us. */
  status?: number
  /** Delay the server asked for, in ms, when it asked for one. */
  retryAfterMs?: number
  /** False when repeating this call can only fail the same way. */
  retryable: boolean
  /** True when a sibling account for the same provider should be tried instead. */
  rotatable: boolean
  /** True when only user action clears it. The breaker latches these. */
  permanent: boolean
}

// --- Account-local quota exhaustion (rotate, long wait) --------------------

// "Your quota will reset after 18h31m10s", "you have exhausted your capacity".
const QUOTA_RESET_TEXT = /quota will reset|exhausted your capacity/i
// "usage limit reached", "usage_limit_reached", "limit_reached".
const USAGE_LIMIT_TEXT =
  /usage[_ -]?limit|usage_limit_reached|usage_not_included|limit_reached|quota[_ -]?(?:exceeded|reached|insufficient)|resource[_ -]?exhausted/i
// Credit and balance exhaustion, which is account-local the same way a quota is.
const CREDITS_EXHAUSTED_TEXT =
  /\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b|insufficient[_ -]?balance|balance[_ -]?exhausted|run out of credits|out of credits/i
const SPEND_LIMIT_TEXT = /spend[_ -]?limit|spending[_ -]?limit/i
// "Your account's rate limit", "rate limit for this organization".
const ACCOUNT_RATE_LIMIT_TEXT =
  /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i
// "Your subscription's rate limits", but NOT "3 requests per minute".
const SUBSCRIPTION_CAP_TEXT =
  /\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i
// Account-scoped caps that arrive on a 403 rather than a 429.
const ACCOUNT_SCOPED_403_TEXT =
  /\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i

// Simplified Chinese account-quota phrasing. The 上限 arm is anchored on 使用
// so a rate or concurrency cap phrased as 每分钟请求数已达上限 does NOT match,
// which would otherwise burn a healthy sibling on a transient throttle.
const CN_QUOTA_TEXT =
  /使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足|额度不足/
// Simplified Chinese rate and concurrency caps can also contain 使用 and 上限
// while remaining transient.
const CN_TRANSIENT_CAP_TEXT =
  /速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/
const CN_THROTTLE_TEXT = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/

// --- Transient signals (wait, same credential) -----------------------------

const PER_INTERVAL_TEXT = /\bper\s+(?:second|minute)\b|\brpm\b|\btpm\b/i
const THROTTLE_TEXT = /rate.?limit|too many requests|throttl/i
const CONCURRENCY_TEXT =
  /\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b/i
const CAPACITY_TEXT = /overloaded|\bcapacity\b|service.?unavailable|\b(?:503|529)\b/i

// --- Auth ------------------------------------------------------------------

// A refresh token the server has thrown away. Repeating this call is the single
// most reliable way to get an account flagged, so it latches permanently.
const AUTH_REVOKED_TEXT =
  /invalid_grant|invalid[_ ]refresh[_ ]token|token (?:has been )?revoked|refresh token (?:is )?(?:invalid|expired|revoked)|reauthenticat|re-authenticat|account (?:is )?(?:disabled|suspended|deactivated)|deactivated_workspace/i

/**
 * A body carries no signal beyond the status itself when it is empty, or only
 * status digits and HTTP framing. Such a response is classified conservatively
 * (an account cap rather than a transient), because the server gave us nothing
 * to go on and guessing "transient" is the guess that keeps hammering.
 */
export function isOpaqueBody(body: string | undefined): boolean {
  if (body === undefined) return true
  const cleaned = body
    .replace(/\b(?:400|401|402|403|408|429|500|502|503|504|529)\b/g, "")
    // The standard reason phrase is the status spelled out. It carries no
    // provider signal, so a body that is only the phrase stays opaque. The
    // subscription transport rejects as "{status} {reason}: {body}", which
    // means an empty upstream body reaches us as exactly that.
    .replace(
      /\b(?:too many requests|payment required|service unavailable|internal server error|bad gateway|gateway timeout|request timeout|bad request|not found|unauthorized|forbidden)\b/gi,
      ""
    )
    .replace(/\b(?:http|https|status|error|code|response|message|body|null|none)\b/gi, "")
    .replace(/[{}[\]",:\s]/g, "")
  if (cleaned.length === 0) return true
  return (
    !/[a-z\d]{3,}/i.test(cleaned) &&
    !CN_QUOTA_TEXT.test(cleaned) &&
    !CN_TRANSIENT_CAP_TEXT.test(cleaned) &&
    !CN_THROTTLE_TEXT.test(cleaned)
  )
}

/** True when the text names an account-local cap rather than a transient one. */
export function isAccountQuotaText(text: string): boolean {
  if (CN_TRANSIENT_CAP_TEXT.test(text)) return false
  if (CN_QUOTA_TEXT.test(text)) return true
  // A subscription cap phrased with a per-interval qualifier is a throttle.
  if (SUBSCRIPTION_CAP_TEXT.test(text) && !PER_INTERVAL_TEXT.test(text)) return true
  return (
    QUOTA_RESET_TEXT.test(text) ||
    USAGE_LIMIT_TEXT.test(text) ||
    CREDITS_EXHAUSTED_TEXT.test(text) ||
    SPEND_LIMIT_TEXT.test(text) ||
    ACCOUNT_RATE_LIMIT_TEXT.test(text)
  )
}

export interface ClassifyInput {
  /** HTTP status, or `undefined` when the transport never got one. */
  status?: number
  /** Response body, or the error message when only that survived. */
  body?: string
  headers?: RetryHintHeaders
  /** Epoch ms, injected so absolute reset stamps stay deterministic. */
  now: number
}

/**
 * Classify one subscription call failure.
 *
 * The order is load-bearing. Revoked auth is checked before everything because
 * its text ("reauthenticate") also matches auth patterns that would otherwise
 * be treated as a refreshable 401. Account quota is checked before the
 * transient throttle branch because quota bodies almost always also say "rate
 * limit". Concurrency is checked before capacity because "too many concurrent
 * requests" contains neither of the capacity words but must not fall through to
 * the generic throttle wait.
 */
export function classifySubscriptionFailure(input: ClassifyInput): SubscriptionFailure {
  const { status, body, now } = input
  const text = body ?? ""
  const retryAfterMs = extractRetryHintMs({ headers: input.headers, body, now })
  const withHint = <T extends Omit<SubscriptionFailure, "retryAfterMs">>(
    failure: T
  ): SubscriptionFailure =>
    retryAfterMs === undefined ? { ...failure, status } : { ...failure, status, retryAfterMs }

  if (text && AUTH_REVOKED_TEXT.test(text)) {
    return withHint({
      reason: "auth-revoked",
      retryable: false,
      rotatable: true,
      permanent: true,
    })
  }

  // 402 is always an account-billing cap for our purposes. Even an informative
  // body ("a subscription is required") means this credential cannot pay for
  // the call, so a sibling is the only thing worth trying.
  if (status === 402) {
    return withHint({
      reason: "billing-cap",
      retryable: true,
      rotatable: true,
      permanent: false,
    })
  }

  if (text && isAccountQuotaText(text)) {
    return withHint({
      reason: "account-quota",
      retryable: true,
      rotatable: true,
      permanent: false,
    })
  }

  // A 403 is normally an auth failure, but several providers deliver an
  // account-scoped cap with it. Only a body that names a cap that RESETS is
  // read that way, so a bare 403 stays an auth failure.
  if (status === 403 && text && ACCOUNT_SCOPED_403_TEXT.test(text)) {
    return withHint({
      reason: "account-quota",
      retryable: true,
      rotatable: true,
      permanent: false,
    })
  }

  if (status === 401 || status === 403) {
    return withHint({
      reason: "auth-expired",
      // Retryable only in the sense that a refresh may fix it. The caller
      // refreshes once. It never loops on this.
      retryable: true,
      rotatable: false,
      permanent: false,
    })
  }

  if (text && CONCURRENCY_TEXT.test(text)) {
    return withHint({
      reason: "concurrency",
      retryable: true,
      rotatable: false,
      permanent: false,
    })
  }

  if (status === 429) {
    // An opaque 429 tells us nothing. Treat it as an account cap: waiting too
    // long costs a stale panel, waiting too little costs the account.
    if (isOpaqueBody(body)) {
      return withHint({
        reason: "account-quota",
        retryable: true,
        rotatable: true,
        permanent: false,
      })
    }
    return withHint({
      reason: "throttled",
      retryable: true,
      rotatable: false,
      permanent: false,
    })
  }

  if (
    text &&
    (CN_THROTTLE_TEXT.test(text) || (THROTTLE_TEXT.test(text) && !CAPACITY_TEXT.test(text)))
  ) {
    return withHint({ reason: "throttled", retryable: true, rotatable: false, permanent: false })
  }

  if (status === 503 || status === 529 || (text && CAPACITY_TEXT.test(text))) {
    return withHint({ reason: "capacity", retryable: true, rotatable: false, permanent: false })
  }

  if (status !== undefined && status >= 500) {
    return withHint({ reason: "server-error", retryable: true, rotatable: false, permanent: false })
  }

  if (status !== undefined && status >= 400) {
    // A 408 is a timeout the server is inviting us to repeat. Every other 4xx
    // is a request we built wrong, and repeating it changes nothing.
    if (status === 408) {
      return withHint({ reason: "network", retryable: true, rotatable: false, permanent: false })
    }
    return withHint({
      reason: "client-error",
      retryable: false,
      rotatable: false,
      permanent: false,
    })
  }

  // No status reached us. Fall back to the shared message classifier for the
  // shapes it reads well, rather than duplicating its network and timeout
  // pattern sets here.
  if (text) {
    const { errorClass } = classifyProviderErrorInfo(text, {}, () => now)
    if (errorClass === "network" || errorClass === "timeout") {
      return withHint({ reason: "network", retryable: true, rotatable: false, permanent: false })
    }
    if (errorClass === "server-error") {
      return withHint({
        reason: "server-error",
        retryable: true,
        rotatable: false,
        permanent: false,
      })
    }
    if (errorClass === "auth") {
      return withHint({
        reason: "auth-expired",
        retryable: true,
        rotatable: false,
        permanent: false,
      })
    }
    if (errorClass === "rate-limit") {
      return withHint({ reason: "throttled", retryable: true, rotatable: false, permanent: false })
    }
  }

  return withHint({ reason: "unknown", retryable: true, rotatable: false, permanent: false })
}

/**
 * Classify a rejected call when all that survived is an error value. The
 * subscription transport rejects non-2xx as `"{status}: {body}"`, matching
 * `classifyUsageError` in `anthropic/usage-endpoint.ts`, so the status is
 * recovered from the message before classification.
 */
export function classifyThrownFailure(error: unknown, now: number): SubscriptionFailure {
  const message = error instanceof Error ? error.message : String(error)
  const status = statusFromMessage(message)
  return classifySubscriptionFailure({ status, body: message, now })
}

/**
 * The HTTP status a rejection message carries, when it carries one.
 *
 * Two shapes only: the transport's own `"{status}: {body}"` / `"{status} {reason}"`
 * prefix, and an explicitly framed `HTTP 503` / `status code 429` anywhere in
 * the text. A bare three-digit number elsewhere is NOT a status. Reading one as
 * a status hands the whole classification to the wrong branch: a body such as
 * `"Bad request: max_tokens 500 exceeds the model limit"` used to be scored as
 * a retryable 5xx outage instead of the non-retryable client error it is.
 */
function statusFromMessage(message: string): number | undefined {
  const prefixed = /^\s*(?:HTTP[/\s]?[\d.]*\s+)?([1-5]\d{2})(?=[\s:,]|$)/.exec(message)
  if (prefixed) return Number(prefixed[1])
  const framed = /\b(?:HTTP|status(?:\s*code)?)[/\s:=]*([1-5]\d{2})\b/i.exec(message)
  return framed ? Number(framed[1]) : undefined
}
