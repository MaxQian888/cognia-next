// Limits query runner. Resolves an account + its bound/default preset, derives
// the source-context inputs, and tries each matching source in priority order
// until one yields a snapshot. All I/O dependencies are injected via the
// optional `deps` arg so the runner is fully testable offline.
//
// Reuses `accessTokenOf` + `resolvePresetForAccount` from the balance runner so
// token/preset resolution stays identical across the two subsystems.

import { refreshAndPersistAnthropicAccount } from "@/lib/subscription/anthropic/refresh"
import { isAnthropicCredentialFresh } from "@/lib/subscription/anthropic/oauth"
import { accessTokenOf, resolvePresetForAccount } from "@/lib/subscription/balance/runner"
import {
  authedGet as defaultAuthedGet,
  getAccount as defaultGetAccount,
  listPresets as defaultListPresets,
} from "@/lib/subscription/core/transport"

import { resolveLimitsSources } from "./registry"

import type {
  Account,
  AnthropicCredentialData,
  LimitsSourceContext,
  ProviderId,
  ProviderLimits,
  ProviderPreset,
} from "@/types/subscription"

export interface LimitsRunnerDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  listPresets: (provider: ProviderId) => Promise<ProviderPreset[]>
  now: () => number
  /**
   * Refresh + persist an Anthropic account's OAuth token, returning the new
   * bearer. Injected so the free `/api/oauth/usage` GET never 401s on a stale
   * token (the primary cause of "Claude 额度刷新无效"). Returns `null` when
   * refresh isn't possible. Defaults to the real vault-backed implementation.
   */
  refreshAnthropicToken: (accountId: string) => Promise<string | null>
  /** Freshness predicate for an Anthropic credential. Injected for tests. */
  isCredentialFresh: (credential: AnthropicCredentialData, now: number) => boolean
}

const DEFAULT_DEPS: LimitsRunnerDeps = {
  authedGet: defaultAuthedGet,
  getAccount: defaultGetAccount,
  listPresets: defaultListPresets,
  now: () => Date.now(),
  refreshAnthropicToken: async (accountId) => {
    const merged = await refreshAndPersistAnthropicAccount(accountId, { reactivate: false })
    return merged?.accessToken ?? null
  },
  isCredentialFresh: (credential, now) => isAnthropicCredentialFresh(credential, now),
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
  const { authedGet, getAccount, listPresets, now, refreshAnthropicToken, isCredentialFresh } = {
    ...DEFAULT_DEPS,
    ...deps,
  }

  const account = await getAccount(provider, accountId)
  if (!account) return null

  let token = accessTokenOf(account.credential)

  // Anthropic OAuth tokens expire (~8h). The free `/api/oauth/usage` GET 401s on
  // a stale bearer, and every layer below swallows the error — so without this
  // proactive refresh the quota UI silently freezes ("Claude 额度刷新无效").
  // Refresh + persist BEFORE the fetch when the stored token is stale; a source
  // may still call `ctx.refreshToken()` reactively on an unexpected 401.
  // `anthropicCred` also narrows the tagged union for `isCredentialFresh`.
  const anthropicCred: AnthropicCredentialData | null =
    provider === "anthropic" && account.credential.provider === "anthropic"
      ? account.credential
      : null
  if (anthropicCred && !isCredentialFresh(anthropicCred, now())) {
    try {
      const refreshed = await refreshAnthropicToken(accountId)
      if (refreshed) token = refreshed
    } catch {
      // Fall through with the stale token; the reactive retry below still tries.
    }
  }

  const presets = await listPresets(provider)
  const preset = resolvePresetForAccount(account, presets)

  const ctx: LimitsSourceContext = {
    provider,
    accountId,
    accountLabel: account.label,
    token,
    baseUrl: preset?.baseUrl,
    providerKey: preset?.templateId,
    presetHeaders: preset?.extraHeaders,
    authedGet,
    refreshToken: anthropicCred
      ? async () => {
          try {
            return await refreshAnthropicToken(accountId)
          } catch {
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
    if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
      return snapshot
    }
  }
  return null
}
