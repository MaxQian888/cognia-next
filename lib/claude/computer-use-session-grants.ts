/**
 * ADR-0020 W3 — per-session Computer Use chat-modal grant store.
 *
 * Wave 1 plumbed `Character.computerUseSettings.chatConsentMode` onto
 * `SendOptions.computerUseConsentMode`. Wave 3 consumes it: when the
 * operator has already approved a Computer Use plugin tool earlier in
 * the same chat session, subsequent invocations within that session
 * should not re-prompt through the chat-side `canUseTool` modal — the
 * Rust-side `ConsentBroker` keeps its own per-tuple session grants for
 * defence-in-depth, so the redundant chat modal is pure friction.
 *
 * Three modes coexist (driven by `Character.computerUseSettings.chatConsentMode`):
 *
 * - `"always-ask"` (default): no grants recorded; every call prompts.
 * - `"session-grant"`: the first approval in a session is sticky for
 *   that tool name; subsequent calls in the session skip the modal.
 * - `"auto"`: the chat modal defers to the Rust gate's tier. The build
 *   step flips `requiresApproval` based on a cached `settingsGet()`;
 *   this store isn't consulted in that mode.
 *
 * Grants live in-memory only. Refreshing the page or closing the
 * session wipes them — the unit of trust is the session, by design.
 * Keep the store agnostic of session shape (just an opaque string).
 */

/** Set of granted plugin-tool names per session id. */
const SESSION_GRANTS: Map<string, Set<string>> = new Map()

/**
 * Record that the operator has approved `toolName` for `sessionId`.
 * Idempotent — repeated calls with the same key are no-ops.
 */
export function recordSessionGrant(sessionId: string, toolName: string): void {
  if (!sessionId || !toolName) return
  let bucket = SESSION_GRANTS.get(sessionId)
  if (!bucket) {
    bucket = new Set<string>()
    SESSION_GRANTS.set(sessionId, bucket)
  }
  bucket.add(toolName)
}

/** True when a grant exists for `(sessionId, toolName)`. */
export function hasSessionGrant(sessionId: string, toolName: string): boolean {
  if (!sessionId || !toolName) return false
  const bucket = SESSION_GRANTS.get(sessionId)
  return bucket !== undefined && bucket.has(toolName)
}

/**
 * Drop every grant for `sessionId`. Wired into session-close handlers
 * so a returning operator on the same machine doesn't inherit
 * grants the previous session accumulated.
 */
export function clearSessionGrants(sessionId: string): void {
  if (!sessionId) return
  SESSION_GRANTS.delete(sessionId)
}

/** Drop every grant globally. Used by the kill-switch shortcut (W3.3). */
export function clearAllSessionGrants(): void {
  SESSION_GRANTS.clear()
}

/** Test-only. Returns a snapshot of the granted tools per session. */
export function __snapshotForTesting(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [sessionId, bucket] of SESSION_GRANTS) {
    out[sessionId] = Array.from(bucket).sort()
  }
  return out
}

/** Test-only — drops every grant. Used in `beforeEach` blocks. */
export function __resetForTesting(): void {
  SESSION_GRANTS.clear()
}
