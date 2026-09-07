// Keeps OAuth-issued provider credentials fresh.
//
// A provider that logs in through OAuth may hand back a short-lived access
// token. Every consumer of that credential reads it the same way, straight off
// `AppSettings.providerSettings[id].apiKey`, and there are a dozen such
// readers spread across the chat, operations and embedding paths. Rather than
// teach each of them to notice an expiry, this keeps the stored key valid, so
// they all stay correct without changing.
//
// The blocking behavior is reused rather than reinvented: the credential
// ledger in `lib/subscription/retry` is provider-agnostic, and its whole
// purpose is to stop a client from re-asking a credential the server already
// refused. A revoked grant latches there instead of being re-POSTed on every
// sweep, which is the same failure this repo has already been bitten by on the
// subscription side.

import {
  refreshOAuthCredential,
  isOAuthCredentialExpiring,
} from "@cognia/provider-core/providers/oauth"
import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "@/lib/subscription/retry/breaker"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"

import type { UserProviderSettings } from "@cognia/provider-types"

/** What happened to one provider during a sweep. */
export type ProviderRefreshOutcome =
  /** Renewed and written back. */
  | { providerId: string; status: "refreshed"; expiresAt?: number }
  /** Not due yet, or nothing to renew it with. */
  | { providerId: string; status: "skipped"; reason: SkipReason }
  /** The provider refused. The credential is blocked and needs a fresh login. */
  | { providerId: string; status: "failed"; message: string }

export type SkipReason =
  "not-oauth" | "no-refresh-token" | "not-expiring" | "blocked" | "no-refresh-support"

export interface RefreshSweepDeps {
  /** Current provider settings, keyed by provider id. */
  readSettings: () => Record<string, UserProviderSettings> | undefined
  /** Persist a renewed credential. */
  writeSettings: (providerId: string, patch: Partial<UserProviderSettings>) => void | Promise<void>
  now?: () => number
  breaker?: SubscriptionBreaker
  random?: () => number
  /** Injected in tests. Defaults to the real exchange. */
  refresh?: typeof refreshOAuthCredential
}

/** Ledger key for one provider's OAuth token endpoint. */
export function providerRefreshKey(providerId: string): string {
  return credentialKey("provider-oauth", providerId, BREAKER_SCOPES.refresh)
}

/**
 * Renew every OAuth provider credential that is close to expiry.
 *
 * Providers are handled independently: one that fails must not stop the rest
 * from being renewed.
 */
export async function refreshExpiringOAuthCredentials(
  deps: RefreshSweepDeps
): Promise<ProviderRefreshOutcome[]> {
  const settings = deps.readSettings()
  if (!settings) return []
  const now = deps.now ?? Date.now
  const breaker = deps.breaker ?? getSubscriptionBreaker()
  const refresh = deps.refresh ?? refreshOAuthCredential

  const outcomes: ProviderRefreshOutcome[] = []
  for (const [providerId, row] of Object.entries(settings)) {
    if (!row?.oauthConnected) {
      outcomes.push({ providerId, status: "skipped", reason: "not-oauth" })
      continue
    }
    if (!isOAuthCredentialExpiring(row.oauthExpiresAt, now())) {
      outcomes.push({ providerId, status: "skipped", reason: "not-expiring" })
      continue
    }
    if (!row.oauthRefreshToken) {
      // A long-lived key (or a row written before the token was kept). There
      // is nothing to spend, and re-login is the only way forward.
      outcomes.push({ providerId, status: "skipped", reason: "no-refresh-token" })
      continue
    }

    const key = providerRefreshKey(providerId)
    if (!breaker.shouldAttempt(key, now()).allowed) {
      outcomes.push({ providerId, status: "skipped", reason: "blocked" })
      continue
    }

    try {
      const renewed = await refresh(providerId, { refreshToken: row.oauthRefreshToken })
      if (!renewed) {
        // The provider declares no refresh spec. Sweeping it again every tick
        // would be pointless work, so treat it as a lasting condition.
        breaker.recordFailure(
          key,
          { reason: "unknown", retryable: false, rotatable: false, permanent: false },
          now(),
          deps.random
        )
        outcomes.push({ providerId, status: "skipped", reason: "no-refresh-support" })
        continue
      }
      breaker.recordSuccess(key)
      await deps.writeSettings(providerId, {
        apiKey: renewed.apiKey,
        oauthExpiresAt: renewed.expiresAt,
        oauthRefreshToken: renewed.refreshToken,
      })
      outcomes.push({ providerId, status: "refreshed", expiresAt: renewed.expiresAt })
    } catch (error) {
      const failure = classifyThrownFailure(error, now())
      breaker.recordFailure(key, failure, now(), deps.random)
      outcomes.push({
        providerId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
