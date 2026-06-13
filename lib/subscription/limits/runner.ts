// Limits query runner. Resolves an account + its bound/default preset, derives
// the source-context inputs, and tries each matching source in priority order
// until one yields a snapshot. All I/O dependencies are injected via the
// optional `deps` arg so the runner is fully testable offline.
//
// Reuses `accessTokenOf` + `resolvePresetForAccount` from the balance runner so
// token/preset resolution stays identical across the two subsystems.

import { accessTokenOf, resolvePresetForAccount } from "@/lib/subscription/balance/runner"
import {
  authedGet as defaultAuthedGet,
  getAccount as defaultGetAccount,
  listPresets as defaultListPresets,
} from "@/lib/subscription/core/transport"

import { resolveLimitsSources } from "./registry"

import type {
  Account,
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
}

const DEFAULT_DEPS: LimitsRunnerDeps = {
  authedGet: defaultAuthedGet,
  getAccount: defaultGetAccount,
  listPresets: defaultListPresets,
  now: () => Date.now(),
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
  const { authedGet, getAccount, listPresets, now } = { ...DEFAULT_DEPS, ...deps }

  const account = await getAccount(provider, accountId)
  if (!account) return null

  const token = accessTokenOf(account.credential)
  const presets = await listPresets(provider)
  const preset = resolvePresetForAccount(account, presets)

  const ctx: LimitsSourceContext = {
    provider,
    accountId,
    accountLabel: account.label,
    token,
    baseUrl: preset?.baseUrl,
    providerKey: preset?.templateId,
    authedGet,
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
