// Balance query runner. Resolves a full account + its bound/default preset,
// derives the adapter inputs, performs the authed GET via Tauri, and parses
// the result into a normalized `BalanceSnapshot`.
//
// All I/O dependencies (`authedGet`, `getAccount`, `listPresets`) are injected
// via the optional `deps` arg so the runner is fully testable offline.

import {
  authedGet as defaultAuthedGet,
  getAccount as defaultGetAccount,
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
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  getAccount: (provider: ProviderId, accountId: string) => Promise<Account | null>
  listPresets: (provider: ProviderId) => Promise<ProviderPreset[]>
}

const DEFAULT_DEPS: BalanceRunnerDeps = {
  authedGet: defaultAuthedGet,
  getAccount: defaultGetAccount,
  listPresets: defaultListPresets,
}

/** Pull a usable bearer out of any credential shape that carries one. */
export function accessTokenOf(credential: ProviderCredential): string | null {
  switch (credential.provider) {
    case "anthropic":
    case "codex":
    case "opencode-zen":
      return credential.accessToken || null
    case "opencode-discovered":
      return null
  }
}

/** The preset baseUrl for an account, honoring its binding then the default. */
export function resolvePresetForAccount(
  account: Account,
  presets: ProviderPreset[]
): ProviderPreset | null {
  if (account.presetId) {
    const bound = presets.find((p) => p.id === account.presetId)
    if (bound) return bound
  }
  // No per-account binding (or it dangles): fall back to the first preset that
  // carries a templateId/baseUrl. The provider-level default is the first
  // listed preset in practice; we just need any preset with a usable baseUrl.
  return presets.find((p) => p.baseUrl.trim().length > 0) ?? null
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
  const { authedGet, getAccount, listPresets } = { ...DEFAULT_DEPS, ...deps }

  const account = await getAccount(provider, accountId)
  if (!account) return null

  const token = accessTokenOf(account.credential)
  if (!token) return null

  const presets = await listPresets(provider)
  const preset = resolvePresetForAccount(account, presets)
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

  let body: string
  try {
    body = await authedGet(descriptor.url, descriptor.headers)
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

  // The Tauri passthrough returns the raw body as text but not the status
  // code; the adapters treat a parseable JSON body as 200 and surface their
  // own `error` field when the documented fields are missing.
  return adapter.parse(200, body, query)
}
