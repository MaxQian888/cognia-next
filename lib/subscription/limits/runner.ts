// Limits query runner. Resolves an account + its bound/default preset, derives
// the source-context inputs, and tries each matching source in priority order
// until one yields a snapshot. All I/O dependencies are injected via the
// optional `deps` arg so the runner is fully testable offline.
//
// Reuses `accessTokenOf` + `resolvePresetForAccount` from the balance runner so
// token/preset resolution stays identical across the two subsystems.

import {
  AnthropicReauthenticationRequiredError,
  refreshAndPersistAnthropicAccount,
} from "@/lib/subscription/anthropic/refresh"
import { isAnthropicCredentialFresh } from "@/lib/subscription/anthropic/oauth"
import { useAccountStore } from "@/stores/account/account-store"
import {
  assertCodexAccountLifecycleReady,
  CodexReauthenticationRequiredError,
  normalizeCodexLifecycleError,
  refreshCodexAccountIfStale,
} from "@/lib/subscription/codex/refresh"
import { isCodexCredentialFresh } from "@/lib/subscription/codex/oauth"
import { accessTokenOf, resolvePresetForAccount } from "@/lib/subscription/balance/runner"
import {
  authedRequest,
  getAccount as defaultGetAccount,
  getProviderPreset as defaultGetProviderPreset,
  listPresets as defaultListPresets,
} from "@/lib/subscription/core/transport"

import { resolveLimitsSources } from "./registry"

import type {
  Account,
  AnthropicCredentialData,
  CodexCredentialData,
  LimitsSourceContext,
  ProviderId,
  ProviderLimits,
  ProviderPreset,
} from "@/types/subscription"

export interface LimitsRunnerDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  /** POST-capable passthrough (`subscription_authed_request`) for Connect-RPC sources. */
  authedRequest: NonNullable<LimitsSourceContext["authedRequest"]>
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  listPresets: (provider: ProviderId) => Promise<ProviderPreset[]>
  getProviderPreset: (provider: ProviderId) => Promise<ProviderPreset | null>
  now: () => number
  getLocalAccountId: () => string | null
  /**
   * Refresh + persist an Anthropic account's OAuth token, returning the new
   * bearer. Injected so the free `/api/oauth/usage` GET never 401s on a stale
   * token (the primary cause of "Claude 额度刷新无效"). Returns `null` when
   * refresh isn't possible. Defaults to the real vault-backed implementation.
   */
  refreshAnthropicToken: (accountId: string) => Promise<string | null>
  /** Freshness predicate for an Anthropic credential. Injected for tests. */
  isCredentialFresh: (credential: AnthropicCredentialData, now: number) => boolean
  /**
   * Refresh + persist a Codex (ChatGPT-login) account's OAuth token, returning
   * the new bearer. The ChatGPT bearer expires exactly like the Anthropic one,
   * and `/wham/usage` 401s on a stale token — so without this the Codex quota
   * panel silently froze the same way "Claude 额度刷新无效" did. `reactivate:
   * false`: a quota poll must never flip the active-account pointer.
   */
  refreshCodexToken: (accountId: string) => Promise<string | null>
  /** Freshness predicate for a Codex credential. Injected for tests. */
  isCodexFresh: (credential: CodexCredentialData, now: number) => boolean
}

const DEFAULT_DEPS: LimitsRunnerDeps = {
  authedGet: async (url, headers) => {
    const response = await authedRequest({ url, method: "GET", headers })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${response.status}: ${response.body}`)
    }
    return response.body
  },
  authedRequest: async (request) => authedRequest(request),
  getAccount: defaultGetAccount,
  listPresets: defaultListPresets,
  getProviderPreset: defaultGetProviderPreset,
  now: () => Date.now(),
  getLocalAccountId: () => useAccountStore.getState().unlockedAccountId,
  refreshAnthropicToken: async (accountId) => {
    const merged = await refreshAndPersistAnthropicAccount(accountId, { reactivate: false })
    return merged?.accessToken ?? null
  },
  isCredentialFresh: (credential, now) => isAnthropicCredentialFresh(credential, now),
  refreshCodexToken: async (accountId) => {
    const fresh = await refreshCodexAccountIfStale(accountId, { reactivate: false })
    return fresh?.accessToken ?? null
  },
  isCodexFresh: (credential, now) => isCodexCredentialFresh(credential, now),
}

/**
 * Query the unified limits for one account. Returns:
 *   • a `ProviderLimits` snapshot (meters and/or an `error`) from the first
 *     source that produces one,
 *   • `null` when the account can't be resolved or no source applies (the UI
 *     renders this as "no limit data").
 *
 * A source returning `null` means "doesn't apply" → try the next candidate; a
 * source returning a snapshot (even one carrying just an `error`) is terminal.
 */
export async function queryAccountLimits(
  provider: ProviderId,
  accountId: string,
  deps: Partial<LimitsRunnerDeps> = {}
): Promise<ProviderLimits | null> {
  const {
    authedGet,
    authedRequest: authedRequestDep,
    getAccount,
    listPresets,
    getProviderPreset,
    now,
    refreshAnthropicToken,
    isCredentialFresh,
    refreshCodexToken,
    isCodexFresh,
    getLocalAccountId,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  const localAccountId = getLocalAccountId()
  let lifecycleError: Error | null = null
  const assertScope = () => {
    if (getLocalAccountId() !== localAccountId) {
      lifecycleError = new Error("Subscription local account changed during limits query")
    }
    if (lifecycleError) throw lifecycleError
  }
  const account = await getAccount(provider, accountId)
  assertScope()
  if (!account) return null
  if (account.credential.provider === "codex") assertCodexAccountLifecycleReady(account)

  let token = accessTokenOf(account.credential)

  // Both OAuth providers expire their bearer (~8h Anthropic, ChatGPT session for
  // Codex) and both usage endpoints 401 on a stale one — so refresh + persist
  // BEFORE the fetch when the stored token is stale; a source may still call
  // `ctx.refreshToken()` reactively on an unexpected 401. Without this the quota
  // UI silently freezes ("Claude 额度刷新无效"). The narrowed `*Cred` locals also
  // narrow the tagged union for the freshness predicates.
  //
  // Codex `api_key` logins never expire and carry no refresh token;
  // `isCodexCredentialFresh` already reports them fresh, so they skip this.
  const anthropicCred: AnthropicCredentialData | null =
    provider === "anthropic" && account.credential.provider === "anthropic"
      ? account.credential
      : null
  // Only a `chatgpt` login is refreshable: an `api_key` credential has no
  // refresh token and never expires, so it gets no callback at all.
  const codexCred: CodexCredentialData | null =
    provider === "codex" &&
    account.credential.provider === "codex" &&
    account.credential.authMode === "chatgpt"
      ? account.credential
      : null

  const runRefresh: (() => Promise<string | null>) | undefined = anthropicCred
    ? () => refreshAnthropicToken(accountId)
    : codexCred
      ? () => refreshCodexToken(accountId)
      : undefined
  let refreshAttempt: Promise<string | null> | null = null
  const refreshBearer: (() => Promise<string | null>) | undefined = runRefresh
    ? () => {
        assertScope()
        refreshAttempt ??= runRefresh().catch((cause) => {
          const error = normalizeCodexLifecycleError(cause)
          if (
            (codexCred && error instanceof CodexReauthenticationRequiredError) ||
            (anthropicCred && error instanceof AnthropicReauthenticationRequiredError)
          ) {
            lifecycleError = error
          }
          throw error
        })
        return refreshAttempt
      }
    : undefined

  const isStale =
    (anthropicCred &&
      (anthropicCred.originalSource === "file" ||
        anthropicCred.originalSource === "keyring" ||
        !isCredentialFresh(anthropicCred, now()))) ||
    (codexCred && !isCodexFresh(codexCred, now()))

  if (isStale && refreshBearer) {
    try {
      const refreshed = await refreshBearer()
      if (refreshed) token = refreshed
    } catch {
      if (lifecycleError) throw lifecycleError
      // Only transient refresh failures may fall back to the stored token.
    }
  }

  assertScope()
  const presets = await listPresets(provider)
  assertScope()
  const preset = await resolvePresetForAccount(account, presets, () => getProviderPreset(provider))
  assertScope()

  const ctx: LimitsSourceContext = {
    provider,
    accountId,
    accountLabel: account.label,
    token,
    credential: account.credential,
    baseUrl: preset?.baseUrl,
    providerKey: preset?.templateId,
    presetHeaders: preset?.extraHeaders,
    // Sources can catch refresh errors themselves. Once identity validation
    // fails, no source may continue with the cached bearer or try another source.
    authedGet: (...args) => {
      assertScope()
      return authedGet(...args)
    },
    authedRequest: (...args) => {
      assertScope()
      return authedRequestDep(...args)
    },
    refreshToken: refreshBearer
      ? async () => {
          try {
            return await refreshBearer()
          } catch {
            if (lifecycleError) throw lifecycleError
            return null
          }
        }
      : undefined,
    now: now(),
  }

  const sources = resolveLimitsSources({
    provider,
    providerKey: ctx.providerKey,
    baseUrl: ctx.baseUrl,
  })
  if (sources.length === 0) return null

  for (const source of sources) {
    let snapshot: ProviderLimits | null
    try {
      snapshot = await source.fetch(ctx)
    } catch {
      snapshot = null
    }
    assertScope()
    if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
      // Persistence and account-level consumers key by the vault identity.
      // Preserve the source separately so relay branding/provenance survives.
      return {
        ...snapshot,
        sourceId: snapshot.sourceId ?? snapshot.provider,
        provider,
        accountId,
        accountLabel: account.label,
      }
    }
  }
  return null
}
