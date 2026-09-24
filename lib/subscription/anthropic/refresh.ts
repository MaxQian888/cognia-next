// Claude Code owns reused logins. Cognia may re-read their credentials, but
// must never rotate a copied refresh token or silently adopt a different login.
import {
  getAccount as defaultGetAccount,
  refreshAnthropicAccountCredential,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"
import { useAccountStore } from "@/stores/account/account-store"
import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "@/lib/subscription/retry/breaker"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"
import { refreshAccessToken as defaultRefreshAccessToken } from "./oauth"
import { discoverAnthropicAuth, discoveredToCredential } from "./discovery"
import type { Account, AnthropicCredentialData, ProviderId } from "@/types/subscription"

export class AnthropicReauthenticationRequiredError extends Error {
  readonly code = "reauth_required"

  constructor(readonly reason: string) {
    super(`Claude account requires reauthentication (${reason})`)
    this.name = "AnthropicReauthenticationRequiredError"
  }
}

export interface RefreshAnthropicDeps {
  refreshAccessToken: typeof defaultRefreshAccessToken
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  /** The host compares the old credential under the vault mutation lock. */
  persistCredential: (
    localAccountId: string,
    accountId: string,
    expected: AnthropicCredentialData,
    credential: AnthropicCredentialData
  ) => Promise<unknown>
  getLocalAccountId: () => string | null
  setActiveAccount: (provider: ProviderId, accountId: string | null) => Promise<void>
  now: () => number
  discoverLocalCredential: () => Promise<AnthropicCredentialData | null>
  /** Only the explicit Account-tab refresh reactivates the account. */
  reactivate: boolean
  breaker: SubscriptionBreaker
  random?: () => number
}

const DEFAULT_DEPS: RefreshAnthropicDeps = {
  refreshAccessToken: defaultRefreshAccessToken,
  getAccount: defaultGetAccount,
  persistCredential: refreshAnthropicAccountCredential,
  getLocalAccountId: () => useAccountStore.getState().unlockedAccountId,
  setActiveAccount: defaultSetActiveAccount,
  now: () => Date.now(),
  discoverLocalCredential: async () => {
    const discovered = await discoverAnthropicAuth()
    return discovered ? discoveredToCredential(discovered) : null
  },
  reactivate: false,
  breaker: getSubscriptionBreaker(),
}

interface RefreshInFlight {
  promise: Promise<AnthropicCredentialData | null>
  reactivateRequested: boolean
}

const refreshesInFlight = new Map<string, RefreshInFlight>()

/**
 * Coalesce refreshes within one local account. Persist with a host-side
 * compare-and-swap, never an upsert, and stop if the local account is locked
 * or switched while asynchronous discovery/exchange is in progress.
 *
 * Claude's discovered tokens are opaque and contain no verified identity.
 * A changed refresh token therefore requires explicit re-import, including
 * a legitimate CLI rotation: guessing would silently switch users.
 */
export function refreshAndPersistAnthropicAccount(
  accountId: string,
  deps: Partial<RefreshAnthropicDeps> = {}
): Promise<AnthropicCredentialData | null> {
  const resolved = { ...DEFAULT_DEPS, ...deps }
  const localAccountId = resolved.getLocalAccountId()
  if (!localAccountId) {
    return Promise.reject(new AnthropicReauthenticationRequiredError("local_account_locked"))
  }
  const flightKey = JSON.stringify([localAccountId, accountId])
  const existing = refreshesInFlight.get(flightKey)
  if (existing) {
    if (resolved.reactivate) existing.reactivateRequested = true
    return existing.promise
  }
  const entry: RefreshInFlight = {
    promise: Promise.resolve(null),
    reactivateRequested: resolved.reactivate,
  }
  entry.promise = runRefresh(
    localAccountId,
    accountId,
    resolved,
    () => entry.reactivateRequested
  ).finally(() => {
    if (refreshesInFlight.get(flightKey) === entry) refreshesInFlight.delete(flightKey)
  })
  refreshesInFlight.set(flightKey, entry)
  return entry.promise
}

export function __resetAnthropicRefreshInFlightForTesting(): void {
  refreshesInFlight.clear()
}

async function runRefresh(
  localAccountId: string,
  accountId: string,
  deps: RefreshAnthropicDeps,
  shouldReactivate: () => boolean
): Promise<AnthropicCredentialData | null> {
  const assertScope = () => {
    if (deps.getLocalAccountId() !== localAccountId) {
      throw new AnthropicReauthenticationRequiredError("local_account_changed")
    }
  }
  let account: Account | null
  try {
    account = await deps.getAccount("anthropic", accountId)
  } catch {
    assertScope()
    throw new AnthropicReauthenticationRequiredError("account_unavailable")
  }
  assertScope()
  if (!account) throw new AnthropicReauthenticationRequiredError("account_removed")
  if (account.credential.provider !== "anthropic") return null
  const credential = account.credential
  const linked = credential.originalSource === "file" || credential.originalSource === "keyring"
  let updated: AnthropicCredentialData
  if (linked) {
    // Local discovery is not a token-endpoint request. Never suppress identity
    // checks through the network breaker or fall back to a cached login.
    let discovered: AnthropicCredentialData | null
    try {
      discovered = await deps.discoverLocalCredential()
    } catch {
      throw new AnthropicReauthenticationRequiredError("external_login_unavailable")
    }
    assertScope()
    if (!discovered) throw new AnthropicReauthenticationRequiredError("external_login_unavailable")
    if (
      !credential.refreshToken ||
      !discovered.accessToken ||
      discovered.refreshToken !== credential.refreshToken ||
      discovered.mode !== credential.mode
    ) {
      throw new AnthropicReauthenticationRequiredError("external_login_changed")
    }
    updated = discovered
  } else {
    const { breaker, now } = deps
    const key = credentialKey("anthropic", accountId, BREAKER_SCOPES.refresh)
    if (!breaker.shouldAttempt(key, now()).allowed) return null
    try {
      updated = await deps.refreshAccessToken({
        refreshToken: credential.refreshToken,
        mode: credential.mode,
      })
      breaker.recordSuccess(key)
    } catch (error) {
      assertScope()
      breaker.recordFailure(key, classifyThrownFailure(error, now()), now(), deps.random)
      throw error
    }
    // No scope check between a successful exchange and its persistence: the
    // server has already rotated (and revoked) the old refresh token, and the
    // write below is addressed to the captured local account. Dropping the
    // response here would leave that account's vault holding a dead token.
  }
  const merged: AnthropicCredentialData = {
    ...credential,
    ...updated,
    originalSource: credential.originalSource,
    email: updated.email ?? credential.email,
    plan: updated.plan ?? credential.plan,
  }
  let result = merged
  // A linked login re-read unchanged (the common poll) is not a vault write:
  // persisting it would bump the rotation stamp, mark the vault for cloud sync
  // and re-fire every subscription listener on each limits query.
  if (!sameCredential(merged, credential)) {
    try {
      await deps.persistCredential(localAccountId, accountId, credential, merged)
    } catch {
      // A deleted row must not be recreated by an old refresh response. A lost
      // compare-and-swap is different: the stored credential changed while
      // this refresh was in flight (the configdir watcher saving a CLI
      // rotation, a reimport), and that newer credential is the account's
      // truth — adopt it instead of calling a healthy account unauthenticated.
      const current = await deps.getAccount("anthropic", accountId).catch(() => null)
      const stored = current?.credential.provider === "anthropic" ? current.credential : null
      if (!stored || sameCredential(stored, credential)) {
        throw new AnthropicReauthenticationRequiredError("credential_update_rejected")
      }
      result = stored
    }
  }
  assertScope()
  if (shouldReactivate()) {
    await deps.setActiveAccount("anthropic", accountId)
    assertScope()
  }
  return result
}

/** Same login material: the fields a refresh writes or a watcher rotates. */
function sameCredential(a: AnthropicCredentialData, b: AnthropicCredentialData): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAtMs === b.expiresAtMs &&
    a.mode === b.mode &&
    a.scope === b.scope &&
    a.email === b.email &&
    a.plan === b.plan
  )
}
