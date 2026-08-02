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
// action-review.ts (ADR-0102), and thread-handoff.ts (ADR-0103).
//
// Zero-dependency hand-written guards, matching the rest of this package.

/** Secret-shaped values that must never appear in a ref position. */
const SECRET_SHAPE = /sk-[A-Za-z0-9]|api[_-]?key|bearer\s|(^|[^a-z])token[=:]/i
/** URL-shaped values — endpoints resolve from the deployment profile, not here. */
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i
/** POSIX (`/srv/x`) and Windows (`C:\x`, `C:/x`) absolute paths. */
const ABSOLUTE_PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/])/

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
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
