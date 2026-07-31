// Refresh + persist an Anthropic OAuth account's access token.
//
// This is the single source of truth for "the stored access token is stale →
// swap the refresh_token for a fresh access_token and write it back to the
// vault". Two callers use it:
//   * `useActiveAnthropicCredential.refresh` (Account tab) — with
//     `reactivate: true`, so the in-process bearer + sidecar pick up the new
//     token (its historical behaviour).
//   * the unified-limits runner (`limits/runner.ts`) — with `reactivate: false`,
//     so a background quota refresh keeps the vaulted token fresh WITHOUT
//     flipping the active pointer / restarting the sidecar mid-chat.
//
// The function always re-reads the account from the vault so it uses the latest
// refresh_token (the server may rotate it on every refresh — see oauth.ts). All
// I/O is injected via `deps` so the runner + hook stay unit-testable offline.

import {
  getAccount as defaultGetAccount,
  saveAccount as defaultSaveAccount,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"

import { refreshAccessToken as defaultRefreshAccessToken } from "./oauth"
import { discoverAnthropicAuth, discoveredToCredential } from "./discovery"

import type { Account, AnthropicCredentialData, ProviderId } from "@/types/subscription"

export interface RefreshAnthropicDeps {
  refreshAccessToken: typeof defaultRefreshAccessToken
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  saveAccount: (provider: ProviderId, account: Account) => Promise<void>
  setActiveAccount: (provider: ProviderId, accountId: string | null) => Promise<void>
  now: () => number
  /** Re-read the CLI-owned credential for accounts adopted via Reuse. */
  discoverLocalCredential: () => Promise<AnthropicCredentialData | null>
  /**
   * When `true`, re-activate the account after persisting so the in-process
   * OAuth bearer + sidecar pick up the new token (restarts the sidecar).
   * Defaults to `false` — background quota refreshes must not restart the
   * sidecar.
   */
  reactivate: boolean
}

const DEFAULT_DEPS: RefreshAnthropicDeps = {
  refreshAccessToken: defaultRefreshAccessToken,
  getAccount: defaultGetAccount,
  saveAccount: defaultSaveAccount,
  setActiveAccount: defaultSetActiveAccount,
  now: () => Date.now(),
  discoverLocalCredential: async () => {
    const discovered = await discoverAnthropicAuth()
    return discovered ? discoveredToCredential(discovered) : null
  },
  reactivate: false,
}

interface RefreshInFlight {
  promise: Promise<AnthropicCredentialData | null>
  reactivateRequested: boolean
}

const refreshesInFlight = new Map<string, RefreshInFlight>()

/**
 * Refresh the OAuth access token for one Anthropic account and persist the
 * result back to the vault (an upsert by the same account id). Returns the
 * merged credential on success, or `null` when the account no longer exists or
 * isn't an Anthropic credential. Throws only if the refresh exchange itself
 * fails (network / invalid_grant) — callers decide whether to swallow. Calls
 * for the same account are single-flight so a rotating refresh token is never
 * exchanged twice. Reactivation is applied at most once, right after
 * persistence: a caller requesting it that joins *before* the shared refresh
 * reaches that step promotes the in-flight refresh to reactivate. A caller
 * that joins in the narrow window *after* the reactivation decision (but before
 * the entry is cleared) still shares the credential result, yet does not
 * trigger a second (redundant) sidecar restart.
 */
export function refreshAndPersistAnthropicAccount(
  accountId: string,
  deps: Partial<RefreshAnthropicDeps> = {}
): Promise<AnthropicCredentialData | null> {
  const existing = refreshesInFlight.get(accountId)
  if (existing) {
    if (deps.reactivate === true) existing.reactivateRequested = true
    return existing.promise
  }

  const entry: RefreshInFlight = {
    promise: Promise.resolve(null),
    reactivateRequested: deps.reactivate === true,
  }
  entry.promise = runRefreshAndPersistAnthropicAccount(
    accountId,
    deps,
    () => entry.reactivateRequested
  ).finally(() => {
    if (refreshesInFlight.get(accountId) === entry) refreshesInFlight.delete(accountId)
  })
  refreshesInFlight.set(accountId, entry)
  return entry.promise
}

async function runRefreshAndPersistAnthropicAccount(
  accountId: string,
  deps: Partial<RefreshAnthropicDeps>,
  shouldReactivate: () => boolean
): Promise<AnthropicCredentialData | null> {
  const {
    refreshAccessToken,
    getAccount,
    saveAccount,
    setActiveAccount,
    now,
    discoverLocalCredential,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  const account = await getAccount("anthropic", accountId)
  if (!account || account.credential.provider !== "anthropic") return null
  const credential = account.credential

  // A reused Claude Code login remains owned by the CLI. Its refresh token can
  // rotate, so exchanging Cognia's copied token would invalidate the keyring /
  // credentials-file copy. CCSwitch avoids that race by reading the CLI store
  // at query time; mirror that ownership rule here.
  const followsLocalLogin =
    credential.originalSource === "file" || credential.originalSource === "keyring"
  const updated = followsLocalLogin
    ? await discoverLocalCredential()
    : await refreshAccessToken({
        refreshToken: credential.refreshToken,
        mode: credential.mode,
      })
  if (!updated) return null
  const merged: AnthropicCredentialData = {
    ...credential,
    ...updated,
    // The refresh response may omit claims present on the original login; keep
    // the richer of the two so the UI badge doesn't lose email / plan.
    email: updated.email ?? credential.email,
    plan: updated.plan ?? credential.plan,
  }

  const next: Account = {
    ...account,
    credential: { provider: "anthropic", ...merged },
    lastUsedAtMs: now(),
  }
  // The Rust vault treats a save with an existing id as an upsert.
  await saveAccount("anthropic", next)

  // Only the Account-tab refresh wants the sidecar to adopt the new bearer
  // immediately; the quota path deliberately skips this to avoid a restart.
  if (shouldReactivate()) await setActiveAccount("anthropic", accountId)

  return merged
}
