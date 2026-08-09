// Subscription-vault → chat-provider bridge for the OpenCode managed plans.
//
// The "opencode" / "opencode-go" built-in chat providers normally read their
// API key from Settings → Providers. When the user never configured one,
// `resolveSendOptions` falls back here: the explicitly selected/default account,
// or the active account when no higher-precedence selection exists,
// in the OpenCode subscription vault supplies the key, so a pasted Zen/Go
// subscription key is immediately usable in chat with zero extra setup —
// the same convenience the Anthropic subscription path already has.
//
// Plan matching: the vault stores Zen and Go accounts side by side under the
// single "opencode" provider. The chat-provider id picks which plan we want
// ("opencode" → zen, "opencode-go" → go). A mismatched active account is not
// silently replaced with a recently-used credential.

import { isTauri } from "@/lib/tauri"
import {
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listPresets,
} from "@/lib/subscription/core/transport"
import type { Account, ProviderPreset } from "@/types/subscription"
import {
  isOpencodeChatProviderId,
  opencodeDefaultBaseUrl,
  planForOpencodeChatProvider,
} from "@/types/subscription"

export interface OpencodeVaultCredential {
  apiKey: string
  baseURL: string
}

/**
 * Resolve a usable API key + base URL for an opencode chat provider from the
 * subscription vault. Returns `null` when the id isn't an opencode provider,
 * outside Tauri (vault is desktop-only), when no matching account exists, or
 * on any transport error — callers treat `null` as "no fallback available".
 */
export async function resolveOpencodeVaultCredential(
  providerId: string,
  selectedAccountId?: string | null
): Promise<OpencodeVaultCredential | null> {
  if (!isOpencodeChatProviderId(providerId)) return null
  if (!isTauri()) return null
  const wantPlan = planForOpencodeChatProvider(providerId)
  try {
    const accountId =
      selectedAccountId === undefined
        ? (await getActiveAccount("opencode")).activeAccountId
        : selectedAccountId || (await getActiveAccount("opencode")).activeAccountId
    if (!accountId) return null
    const full = await getAccount("opencode", accountId)
    if (!full || full.credential.provider !== "opencode-zen") return null
    if ((full.credential.plan ?? "zen") !== wantPlan) return null
    const apiKey = full.credential.accessToken?.trim()
    if (!apiKey) return null
    // Precedence mirrors the Rust env_for_sidecar: bound/default preset
    // (relay config) > per-account override > the plan's default gateway.
    const preset = await resolvePresetFor(full)
    const baseURL =
      preset?.baseUrl?.trim() || full.credential.baseUrl?.trim() || opencodeDefaultBaseUrl(wantPlan)
    return { apiKey, baseURL }
  } catch {
    return null
  }
}

/**
 * Resolve the preset an account draws its relay config from: the account's
 * own binding first, the provider-level default otherwise (same order as
 * Rust `ProviderVault::resolve_preset`). Errors degrade to "no preset".
 */
async function resolvePresetFor(account: Account): Promise<ProviderPreset | null> {
  try {
    if (account.presetId) {
      const bound = (await listPresets("opencode")).find((p) => p.id === account.presetId)
      if (bound) return bound
    }
    return await getProviderPreset("opencode")
  } catch {
    return null
  }
}
