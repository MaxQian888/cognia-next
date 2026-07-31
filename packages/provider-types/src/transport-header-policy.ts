/**
 * Shared transport header policy (ADR-0090 Phase 1).
 *
 * The single authority on which HTTP headers a TransportProfile may stamp
 * (`context: "static"`) or forward from an inbound request
 * (`context: "forward"`). Mirrored byte-for-byte by the Rust implementation
 * in `crates/cognia-gateway/src/header_policy.rs`; both test suites iterate
 * the same fixture (`fixtures/header-policy-cases.json`) so the two can never
 * drift.
 *
 * Reason codes are stable identifiers: UI error messages i18n-key off them
 * and the Rust side re-emits the same strings.
 */

export const HEADER_POLICY_VERSION = 1

export type HeaderPolicyContext = "static" | "forward"

export type HeaderPolicyReason =
  | "ok"
  | "invalid-name"
  | "invalid-value"
  | "auth-header"
  | "hop-by-hop"
  | "host-header"
  | "content-framing"
  | "cookie-header"
  | "browser-forwarding"
  | "internal-header"

export interface HeaderPolicyVerdict {
  allowed: boolean
  reason: HeaderPolicyReason
}

// RFC 7230 token characters for field names.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const AUTH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-authenticate",
])

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
])

const CONTENT_FRAMING_HEADERS = new Set(["content-length"])

const COOKIE_HEADERS = new Set(["cookie", "set-cookie"])

const BROWSER_FORWARDING_HEADERS = new Set(["origin", "referer", "forwarded"])
const BROWSER_FORWARDING_PREFIXES = ["x-forwarded-", "sec-"]

const INTERNAL_PREFIXES = ["x-cognia-"]

/**
 * Inbound semantic headers forwarded upstream by default on same-protocol
 * routes (Phase 2). Auth headers are structurally excluded above.
 */
export const SEMANTIC_FORWARD_PREFIXES = ["anthropic-", "x-claude-code-", "x-stainless-"]
export const SEMANTIC_FORWARD_HEADERS = new Set(["x-app"])

function classifyName(name: string): HeaderPolicyReason {
  if (!TOKEN_RE.test(name)) return "invalid-name"
  const lower = name.toLowerCase()
  if (AUTH_HEADERS.has(lower)) return "auth-header"
  if (HOP_BY_HOP_HEADERS.has(lower)) return "hop-by-hop"
  if (lower === "host") return "host-header"
  if (CONTENT_FRAMING_HEADERS.has(lower)) return "content-framing"
  if (COOKIE_HEADERS.has(lower)) return "cookie-header"
  if (
    BROWSER_FORWARDING_HEADERS.has(lower) ||
    BROWSER_FORWARDING_PREFIXES.some((prefix) => lower.startsWith(prefix))
  ) {
    return "browser-forwarding"
  }
  if (INTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "internal-header"
  return "ok"
}

function hasIllegalValueBytes(value: string): boolean {
  // CR / LF / NUL enable header injection; leading/trailing whitespace is
  // normalized rather than rejected, so only the dangerous bytes fail.
  return /[\r\n\0]/.test(value)
}

/**
 * Validate one header for a given context. `value` is required for
 * `static` entries; `forward` entries validate the name only (the value is
 * the inbound request's and is re-checked at proxy time).
 */
export function checkHeader(
  name: string,
  value: string | undefined,
  context: HeaderPolicyContext
): HeaderPolicyVerdict {
  const nameVerdict = classifyName(name)
  if (nameVerdict !== "ok") return { allowed: false, reason: nameVerdict }
  if (context === "static") {
    if (value === undefined || hasIllegalValueBytes(value)) {
      return { allowed: false, reason: "invalid-value" }
    }
  }
  return { allowed: true, reason: "ok" }
}

export interface HeaderPolicyViolation {
  name: string
  reason: HeaderPolicyReason
}

/** Validate a TransportProfile's static header map. Empty array ⇒ valid. */
export function validateStaticHeaders(
  headers: Record<string, string> | undefined
): HeaderPolicyViolation[] {
  if (!headers) return []
  const violations: HeaderPolicyViolation[] = []
  for (const [name, value] of Object.entries(headers)) {
    const verdict = checkHeader(name, value, "static")
    if (!verdict.allowed) violations.push({ name, reason: verdict.reason })
  }
  return violations
}

/** Validate a TransportProfile's forwarded-semantic-header list. */
export function validateForwardedSemanticHeaders(
  names: string[] | undefined
): HeaderPolicyViolation[] {
  if (!names) return []
  const violations: HeaderPolicyViolation[] = []
  for (const name of names) {
    const verdict = checkHeader(name, undefined, "forward")
    if (!verdict.allowed) violations.push({ name, reason: verdict.reason })
  }
  return violations
}

/**
 * Whether an inbound header is on the built-in semantic forwarding
 * allowlist (same-protocol passthrough, Phase 2). Auth/hop-by-hop/etc. are
 * excluded structurally — a blocked name is never semantic.
 */
export function isForwardableSemanticHeader(name: string): boolean {
  if (classifyName(name) !== "ok") return false
  const lower = name.toLowerCase()
  return (
    SEMANTIC_FORWARD_HEADERS.has(lower) ||
    SEMANTIC_FORWARD_PREFIXES.some((prefix) => lower.startsWith(prefix))
  )
}
