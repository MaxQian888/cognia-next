/**
 * Credential-expiry state for an `AccountSummary`, for the multi-account list.
 *
 * `AccountSummary.expiresAtMs` already rides along in the cheap summary the
 * account picker fetches, but nothing rendered it — so a user with several
 * saved accounts had no read-out at all until they switched to one.
 *
 * Deliberately narrow about what it claims. `expiresAtMs` is the **access**
 * token's expiry, and an elapsed access token is routine: `refresh.ts` swaps it
 * for a fresh one on next use. Refresh *failures* are not persisted anywhere in
 * the vault, so there is no signal here for "this account is dead" and this
 * helper does not pretend otherwise — `stale` means "will be refreshed on next
 * use", not "broken".
 *
 * The 60s grace mirrors `isAnthropicCredentialFresh` in `anthropic/oauth.ts`,
 * so the list and the "logged in?" badge can't disagree at the boundary.
 */

export type AccountExpiryState =
  /** `expiresAtMs === 0` — api_key / opencode-zen logins never expire. */
  | "notApplicable"
  /** Access token still valid. */
  | "valid"
  /** Access token elapsed; the next use refreshes it. */
  | "stale"

export const ACCOUNT_EXPIRY_GRACE_MS = 60_000

export function accountExpiryState(
  expiresAtMs: number,
  nowMs: number,
  graceMs: number = ACCOUNT_EXPIRY_GRACE_MS
): AccountExpiryState {
  // Guard the whole non-positive/non-finite range, not just 0: a malformed
  // vault row must not render as "expired 56 years ago".
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return "notApplicable"
  return expiresAtMs - graceMs > nowMs ? "valid" : "stale"
}
