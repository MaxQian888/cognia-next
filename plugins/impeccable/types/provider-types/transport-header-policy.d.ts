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
declare const HEADER_POLICY_VERSION = 1
type HeaderPolicyContext = "static" | "forward"
type HeaderPolicyReason =
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
interface HeaderPolicyVerdict {
  allowed: boolean
  reason: HeaderPolicyReason
}
/**
 * Inbound semantic headers forwarded upstream by default on same-protocol
 * routes (Phase 2). Auth headers are structurally excluded above.
 */
declare const SEMANTIC_FORWARD_PREFIXES: string[]
declare const SEMANTIC_FORWARD_HEADERS: Set<string>
/**
 * Validate one header for a given context. `value` is required for
 * `static` entries; `forward` entries validate the name only (the value is
 * the inbound request's and is re-checked at proxy time).
 */
declare function checkHeader(
  name: string,
  value: string | undefined,
  context: HeaderPolicyContext
): HeaderPolicyVerdict
interface HeaderPolicyViolation {
  name: string
  reason: HeaderPolicyReason
}
/** Validate a TransportProfile's static header map. Empty array ⇒ valid. */
declare function validateStaticHeaders(
  headers: Record<string, string> | undefined
): HeaderPolicyViolation[]
/** Validate a TransportProfile's forwarded-semantic-header list. */
declare function validateForwardedSemanticHeaders(
  names: string[] | undefined
): HeaderPolicyViolation[]
/**
 * Whether an inbound header is on the built-in semantic forwarding
 * allowlist (same-protocol passthrough, Phase 2). Auth/hop-by-hop/etc. are
 * excluded structurally — a blocked name is never semantic.
 */
declare function isForwardableSemanticHeader(name: string): boolean

export {
  HEADER_POLICY_VERSION,
  type HeaderPolicyContext,
  type HeaderPolicyReason,
  type HeaderPolicyVerdict,
  type HeaderPolicyViolation,
  SEMANTIC_FORWARD_HEADERS,
  SEMANTIC_FORWARD_PREFIXES,
  checkHeader,
  isForwardableSemanticHeader,
  validateForwardedSemanticHeaders,
  validateStaticHeaders,
}
