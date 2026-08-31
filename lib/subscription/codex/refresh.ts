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
  refreshManagedCodexAccount as defaultRefreshManagedCodexAccount,
  saveAccount as defaultSaveAccount,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"

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
  refreshCodexToken: (refreshToken: string) => Promise<TokenResponse>
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  saveAccount: (provider: ProviderId, account: Account) => Promise<void>
  setActiveAccount: (provider: ProviderId, accountId: string | null) => Promise<void>
  now: () => number
  /** Re-read the CLI-owned credential for accounts adopted via Reuse. */
  discoverLocalCredential: () => Promise<CodexCredentialData | null>
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
 * Throws only if the refresh exchange itself fails (network / invalid_grant) —
 * callers decide whether to swallow. Both current callers do, falling back to
 * the existing token so a refresh outage degrades to a 401 rather than blocking
 * the turn outright.
 */
export async function refreshCodexAccountIfStale(
  accountId: string,
  deps: Partial<RefreshCodexDeps> = {}
): Promise<CodexCredentialData | null> {
  const useHostLifecycle =
    deps.refreshManagedAccount !== undefined ||
    (deps.refreshCodexToken === undefined &&
      deps.getAccount === undefined &&
      deps.saveAccount === undefined &&
      deps.discoverLocalCredential === undefined)
  const {
    refreshCodexToken,
    getAccount,
    saveAccount,
    setActiveAccount,
    now,
    discoverLocalCredential,
    reactivate,
    refreshManagedAccount,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  const account = await getAccount("codex", accountId)
  if (!account || account.credential.provider !== "codex") return null
  assertCodexAccountLifecycleReady(account)
  const credential = account.credential

  // A reused CLI login remains owned by codex-cli. Refresh tokens may rotate,
  // so exchanging our copied token would invalidate the CLI's auth.json/keyring
  // copy. Re-read the authoritative local login instead (CCSwitch's model).
  if (credential.originalSource === "file" || credential.originalSource === "keyring") {
    const synced = await discoverLocalCredential()
    if (!synced) return null
    await saveAccount("codex", {
      ...account,
      credential: toProviderCredential(synced),
      lastUsedAtMs: now(),
    })
    if (reactivate) await setActiveAccount("codex", accountId)
    return synced
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
