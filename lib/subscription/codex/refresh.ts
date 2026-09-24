// Refresh + persist a Codex (ChatGPT-login) account's access token.
//
// Single source of truth for "the stored bearer is near expiry → swap the
// refresh_token for a fresh access_token and write it back to the vault".
// Mirrors `lib/subscription/anthropic/refresh.ts`. Two callers use it:
//   * `env-builder.maybeRefreshActiveCodex` — before spawning an external agent,
//     with `reactivate: true` so the Rust-side active-env cache rebuilds with
//     the new bearer.
//   * `chat-bridge.resolveCodexVaultCredential` — before handing the credential
//     to a chat provider, with `reactivate: false`: chat reads the token it is
//     returned directly, and flipping the active pointer mid-turn would restart
//     the sidecar underneath the very turn being built.
//
// Both callers previously had to answer "is this stale, and how do I renew it?"
// and only the spawn path ever did — so a reused ChatGPT subscription worked
// for external agents but sent an expired bearer in chat once it aged out.
//
// The account is always re-read from the vault so the LATEST refresh_token is
// used (the server may rotate it on every refresh — see oauth.ts). All I/O is
// injected via `deps` so callers stay unit-testable offline.

import {
  getAccount as defaultGetAccount,
  reauthenticateManagedCodexAccount,
  refreshManagedCodexAccount as defaultRefreshManagedCodexAccount,
  saveAccount as defaultSaveAccount,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"
import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "@/lib/subscription/retry/breaker"
import { classifyThrownFailure } from "@/lib/subscription/retry/failure-class"

import { isCodexCredentialFresh, toProviderCredential, tokenResponseToCredential } from "./oauth"
import { discoverCodexAuth, discoveredToCredential } from "./discovery"

import type { TokenResponse } from "@/lib/subscription/core/transport"
import type { Account, CodexCredentialData, ProviderId } from "@/types/subscription"

export class CodexReauthenticationRequiredError extends Error {
  readonly code = "reauth_required"

  constructor(readonly reason: string) {
    super(`Codex account requires reauthentication (${reason})`)
    this.name = "CodexReauthenticationRequiredError"
  }
}

export function assertCodexAccountLifecycleReady(account: Account): void {
  if (account.authMetadata?.reauthRequiredAtMs) {
    throw new CodexReauthenticationRequiredError(
      account.authMetadata.reauthReason || "refresh_credential_invalid"
    )
  }
}

export function normalizeCodexLifecycleError(cause: unknown): unknown {
  if (cause instanceof CodexReauthenticationRequiredError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const match = message.match(/reauth_required:([a-z0-9_]+)/i)
  return match ? new CodexReauthenticationRequiredError(match[1]) : cause
}

export interface RefreshCodexDeps {
  /**
   * Credential ledger gating the token endpoint. A refresh that fails is
   * blocked before it can be repeated, and a revoked grant latches until the
   * user re-authenticates. Defaults to the process-wide ledger.
   */
  breaker: SubscriptionBreaker
  /** Deterministic jitter source for the recorded backoff. */
  random?: () => number
  refreshCodexToken: (refreshToken: string) => Promise<TokenResponse>
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  saveAccount: (provider: ProviderId, account: Account) => Promise<void>
  setActiveAccount: (provider: ProviderId, accountId: string | null) => Promise<void>
  now: () => number
  /** Re-read the CLI-owned credential for accounts adopted via Reuse. */
  discoverLocalCredential: () => Promise<CodexCredentialData | null>
  /** Host-owned identity check and atomic update for a linked ChatGPT login. */
  reauthenticateAccount: typeof reauthenticateManagedCodexAccount
  /**
   * When `true`, re-activate the account after persisting so the Rust-side
   * active-env snapshot is rebuilt with the new bearer. Defaults to `false` —
   * the chat path must not flip the active pointer mid-turn.
   */
  reactivate: boolean
  /** Host-owned atomic refresh. Tests may omit it to exercise the pure seam. */
  refreshManagedAccount: (accountId: string) => Promise<CodexCredentialData>
}

const DEFAULT_DEPS: RefreshCodexDeps = {
  breaker: getSubscriptionBreaker(),
  refreshCodexToken: async () => {
    throw new Error("Direct renderer token refresh is disabled; use the host lifecycle manager")
  },
  getAccount: defaultGetAccount,
  saveAccount: defaultSaveAccount,
  setActiveAccount: defaultSetActiveAccount,
  now: () => Date.now(),
  discoverLocalCredential: async () => {
    const discovered = await discoverCodexAuth()
    return discovered ? discoveredToCredential(discovered) : null
  },
  reauthenticateAccount: reauthenticateManagedCodexAccount,
  reactivate: false,
  refreshManagedAccount: defaultRefreshManagedCodexAccount,
}

const managedRefreshes = new Map<string, Promise<CodexCredentialData>>()

function refreshManagedOnce(
  accountId: string,
  refresh: (accountId: string) => Promise<CodexCredentialData>
): Promise<CodexCredentialData> {
  const existing = managedRefreshes.get(accountId)
  if (existing) return existing
  const pending = refresh(accountId).finally(() => {
    if (managedRefreshes.get(accountId) === pending) managedRefreshes.delete(accountId)
  })
  managedRefreshes.set(accountId, pending)
  return pending
}

/**
 * Refresh one Codex account's bearer if it is near expiry, and persist the
 * result back to the vault (an upsert by the same account id).
 *
 * Returns the fresh credential when a refresh happened, `null` when none was
 * needed or possible: the account is gone / not a codex credential, it is an
 * `api_key` login (keys don't expire), it carries no refresh token, or it is
 * still fresh. Callers treat `null` as "keep using what you have".
 *
 * Linked CLI credentials are checked through the host's identity-safe
 * reauthentication command. Missing or changed logins fail closed; callers
 * must not fall back to a stored credential after a lifecycle error.
 */
export async function refreshCodexAccountIfStale(
  accountId: string,
  deps: Partial<RefreshCodexDeps> = {}
): Promise<CodexCredentialData | null> {
  const account = await (deps.getAccount ?? DEFAULT_DEPS.getAccount)("codex", accountId)
  if (!account || account.credential.provider !== "codex") return null
  assertCodexAccountLifecycleReady(account)
  const credential = account.credential

  // CLI-owned logins are re-read, never refreshed by Cognia. Keep local
  // identity checks outside the token-endpoint breaker so every attempt
  // rejects a mismatched login and restoring the original login can recover.
  if (credential.originalSource === "file" || credential.originalSource === "keyring") {
    let synced: CodexCredentialData | null
    try {
      synced = await (deps.discoverLocalCredential ?? DEFAULT_DEPS.discoverLocalCredential)()
    } catch {
      throw new CodexReauthenticationRequiredError("external_login_unavailable")
    }
    if (!synced) throw new CodexReauthenticationRequiredError("external_login_unavailable")
    if (synced.authMode !== credential.authMode) {
      throw new CodexReauthenticationRequiredError("external_login_changed")
    }
    if (credential.authMode === "api_key") {
      // API keys have no verifiable user/workspace identity. A changed key
      // needs an explicit import instead of replacing the selected account.
      if (!synced.accessToken || synced.accessToken !== credential.accessToken) {
        throw new CodexReauthenticationRequiredError("external_login_changed")
      }
    } else {
      try {
        // Reuse the host's locked identity check and update. Generic save
        // would allow a CLI account swap or resurrect a concurrently deleted row.
        await (deps.reauthenticateAccount ?? DEFAULT_DEPS.reauthenticateAccount)(accountId, synced)
      } catch {
        throw new CodexReauthenticationRequiredError("external_login_unverified")
      }
    }
    if (deps.reactivate) {
      await (deps.setActiveAccount ?? DEFAULT_DEPS.setActiveAccount)("codex", accountId)
    }
    return synced
  }

  const breaker = deps.breaker ?? getSubscriptionBreaker()
  const now = deps.now ?? DEFAULT_DEPS.now
  const key = credentialKey("codex", accountId, BREAKER_SCOPES.refresh)
  // A refresh that just failed will fail the same way until something changes,
  // and the ChatGPT token endpoint is far tighter than the usage endpoint.
  // Without this, an account whose grant was revoked was re-exchanged on every
  // spawn and every chat turn for as long as the app stayed open.
  if (!breaker.shouldAttempt(key, now()).allowed) return null

  try {
    const fresh = await runRefreshCodexAccountIfStale(account, credential, deps)
    // Only a completed exchange clears the block. The many `null` returns here
    // mean "nothing to refresh", which is no evidence the endpoint is healthy.
    if (fresh) breaker.recordSuccess(key)
    return fresh
  } catch (error) {
    breaker.recordFailure(key, classifyThrownFailure(error, now()), now(), deps.random)
    throw error
  }
}

async function runRefreshCodexAccountIfStale(
  account: Account,
  credential: CodexCredentialData,
  deps: Partial<RefreshCodexDeps>
): Promise<CodexCredentialData | null> {
  const accountId = account.id
  const useHostLifecycle =
    deps.refreshManagedAccount !== undefined ||
    (deps.refreshCodexToken === undefined &&
      deps.getAccount === undefined &&
      deps.saveAccount === undefined &&
      deps.discoverLocalCredential === undefined)
  const {
    refreshCodexToken,
    saveAccount,
    setActiveAccount,
    now,
    reactivate,
    refreshManagedAccount,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  // `api_key` never expires and has no refresh token; `isCodexCredentialFresh`
  // already treats it (and an unknown expiry, expiresAtMs === 0) as fresh, but
  // the refreshToken check keeps the intent explicit for the reader.
  if (credential.authMode !== "chatgpt" || !credential.refreshToken) return null
  if (isCodexCredentialFresh(credential, now())) return null

  if (useHostLifecycle) {
    let fresh: CodexCredentialData
    try {
      fresh = await refreshManagedOnce(accountId, refreshManagedAccount)
    } catch (cause) {
      throw normalizeCodexLifecycleError(cause)
    }
    if (reactivate) await setActiveAccount("codex", accountId)
    return fresh
  }

  const response = await refreshCodexToken(credential.refreshToken)
  const fresh = tokenResponseToCredential(response, {
    previous: credential,
    authMode: "chatgpt",
    nowMs: now(),
  })

  await saveAccount("codex", {
    ...account,
    credential: toProviderCredential(fresh),
    lastUsedAtMs: now(),
  })
  if (reactivate) await setActiveAccount("codex", accountId)

  return fresh
}
