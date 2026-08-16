// Ref-safety guards shared by every cross-boundary contract in this package.
//
// Extracted from handoff-envelope.ts (ADR-0090 Phase 7), which established the
// rule these guards encode: anything that crosses a process or host boundary
// carries ids, enums, and stable REFERENCES — never key material, never a
// credential-bearing URL, never a host-local absolute path. Enforcing that
// structurally makes a leaking payload a validation error at the boundary
// rather than a code-review hope.
//
// Reused by handoff-envelope.ts (parent→child delegation), canonical-session.ts,
// action-review.ts (ADR-0102), thread-handoff.ts (ADR-0103), host-state.ts
// (ADR-0116), and work-submission.ts (ADR-0123).
//
// Zero-dependency hand-written guards, matching the rest of this package.

/**
 * Secret-shaped values that must never appear in a ref position.
 *
 * `sk-` is boundary-guarded the same way `token` is: unanchored, it fires on
 * any id that merely *contains* the letters — `task-1`, `risk-report`,
 * `disk-cache` — which rejects ordinary refs rather than credentials.
 */
const SECRET_SHAPE = /(^|[^a-z])sk-[A-Za-z0-9]|api[_-]?key|bearer\s|(^|[^a-z])token[=:]/i
/** URL-shaped values — endpoints resolve from the deployment profile, not here. */
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i
/** POSIX (`/srv/x`) and Windows (`C:\x`, `C:/x`) absolute paths. */
const ABSOLUTE_PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/])/

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** A plain JSON object — not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Closed-schema check: reject any key the contract does not declare.
 *
 * This is what makes a guard *closed* rather than merely structural. An open
 * guard silently forwards unknown fields across the boundary, which is how a
 * newer peer's payload smuggles data past an older peer's validation.
 */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed)
  return Object.keys(value).every((key) => allow.has(key))
}

/** A safe non-negative integer — the shape every revision/sequence/epoch uses. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Reject secret- and URL-shaped values in a ref position.
 * Returns a violation description, or `null` when the value is safe.
 */
export function refViolation(value: string): string | null {
  if (SECRET_SHAPE.test(value)) return "secret-shaped value in a ref position"
  if (URL_SHAPE.test(value)) return "URL-shaped value in a ref position"
  return null
}

/**
 * Reject machine-local absolute paths, which do not survive a host boundary:
 * the receiving host resolves its own root from a logical ref instead.
 * Returns a violation description, or `null` when the value is safe.
 */
export function absolutePathViolation(value: string): string | null {
  if (ABSOLUTE_PATH_SHAPE.test(value)) {
    return "machine-local absolute path is not a stable ref"
  }
  return null
}
