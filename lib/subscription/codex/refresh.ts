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
  saveAccount as defaultSaveAccount,
  setActiveAccount as defaultSetActiveAccount,
} from "@/lib/subscription/core/transport"

import {
  isCodexCredentialFresh,
  refreshCodexToken as defaultRefreshCodexToken,
  toProviderCredential,
  tokenResponseToCredential,
} from "./oauth"
import { discoverCodexAuth, discoveredToCredential } from "./discovery"

import type { Account, CodexCredentialData, ProviderId } from "@/types/subscription"

export interface RefreshCodexDeps {
  refreshCodexToken: typeof defaultRefreshCodexToken
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
}

const DEFAULT_DEPS: RefreshCodexDeps = {
  refreshCodexToken: defaultRefreshCodexToken,
  getAccount: defaultGetAccount,
  saveAccount: defaultSaveAccount,
  setActiveAccount: defaultSetActiveAccount,
  now: () => Date.now(),
  discoverLocalCredential: async () => {
    const discovered = await discoverCodexAuth()
    return discovered ? discoveredToCredential(discovered) : null
  },
  reactivate: false,
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
  const {
    refreshCodexToken,
    getAccount,
    saveAccount,
    setActiveAccount,
    now,
    discoverLocalCredential,
    reactivate,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  const account = await getAccount("codex", accountId)
  if (!account || account.credential.provider !== "codex") return null
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
