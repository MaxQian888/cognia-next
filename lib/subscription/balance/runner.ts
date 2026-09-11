// Balance query runner. Resolves a full account + its bound/default preset,
// derives the adapter inputs, performs the authed GET via Tauri, and parses
// the result into a normalized `BalanceSnapshot`.
//
// All I/O dependencies (`authedGet`, `getAccount`, `listPresets`) are injected
// via the optional `deps` arg so the runner is fully testable offline.

import {
  authedRequest as defaultAuthedRequest,
  getAccount as defaultGetAccount,
  getProviderPreset as defaultGetProviderPreset,
  listPresets as defaultListPresets,
} from "../core/transport"
import { findBalanceAdapter } from "./registry"

import type {
  Account,
  BalanceSnapshot,
  ProviderCredential,
  ProviderId,
  ProviderPreset,
} from "@/types/subscription"

export interface BalanceRunnerDeps {
  authedRequest: typeof defaultAuthedRequest
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  listPresets: (provider: ProviderId) => Promise<ProviderPreset[]>
  getProviderPreset: (provider: ProviderId) => Promise<ProviderPreset | null>
}

const DEFAULT_DEPS: BalanceRunnerDeps = {
  authedRequest: defaultAuthedRequest,
  getAccount: defaultGetAccount,
  listPresets: defaultListPresets,
  getProviderPreset: defaultGetProviderPreset,
}

/** Pull a usable bearer out of any credential shape that carries one. */
export function accessTokenOf(credential: ProviderCredential): string | null {
  switch (credential.provider) {
    case "anthropic":
    case "codex":
    case "opencode-zen":
    case "commandcode":
    case "api-key":
      return credential.accessToken || null
    case "opencode-discovered":
      return null
  }
}

/** The preset baseUrl for an account, honoring its binding then the default. */
export async function resolvePresetForAccount(
  account: Account,
  presets: ProviderPreset[],
  getDefault: () => Promise<ProviderPreset | null>
): Promise<ProviderPreset | null> {
  if (account.presetId) {
    const bound = presets.find((p) => p.id === account.presetId)
    if (bound) return bound
  }
  // The vault's default pointer is independent of preset insertion order.
  // An absent default must never send this account's token to another preset.
  return getDefault()
}

/**
 * Query the balance for one account. Returns:
 *   • a parsed `BalanceSnapshot` on success,
 *   • a snapshot with `error` set on transport / HTTP failure,
 *   • `null` when the account/preset/token/adapter can't be resolved (the UI
 *     renders this as "balance unavailable").
 */
export async function queryAccountBalance(
  provider: ProviderId,
  accountId: string,
  deps: Partial<BalanceRunnerDeps> = {}
): Promise<BalanceSnapshot | null> {
  const { authedRequest, getAccount, listPresets, getProviderPreset } = { ...DEFAULT_DEPS, ...deps }

  const account = await getAccount(provider, accountId)
  if (!account) return null

  const token = accessTokenOf(account.credential)
  if (!token) return null

  const presets = await listPresets(provider)
  const preset = await resolvePresetForAccount(account, presets, () => getProviderPreset(provider))
  if (!preset) return null

  const providerKey = preset.templateId
  const baseUrl = preset.baseUrl
  const adapter = findBalanceAdapter({ providerKey, baseUrl })
  if (!adapter) return null

  const query = {
    accountId,
    providerKey: providerKey ?? adapter.key,
    baseUrl,
    token,
  }
  const descriptor = adapter.request(query)

  let response: Awaited<ReturnType<typeof authedRequest>>
  try {
    response = await authedRequest({
      url: descriptor.url,
      method: "GET",
      headers: descriptor.headers,
    })
  } catch (err) {
    return {
      fetchedAt: Date.now(),
      providerKey: query.providerKey,
      accountId,
      kind: "credit",
      raw: {},
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return adapter.parse(response.status, response.body, query)
}
