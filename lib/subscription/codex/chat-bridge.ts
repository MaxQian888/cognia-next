// Subscription-vault → chat-provider bridge for Codex (OpenAI).
//
// The "codex" built-in chat provider normally reads its API key from Settings →
// Providers. When the user never configured one, `resolveSendOptions` falls back
// here: the active (or most-recently-used) account in the Codex subscription
// vault supplies the credential, so a reused ChatGPT-login or pasted API key is
// immediately usable in chat — the same convenience the Anthropic/OpenCode paths
// have.
//
// Two auth modes (verified against `openai/codex`):
//   • api_key  → genuine OpenAI Responses API at api.openai.com/v1, bearer only.
//   • chatgpt  → the ChatGPT backend (chatgpt.com/backend-api/codex), which is
//     Responses-only and additionally requires ChatGPT-Account-Id / OpenAI-Beta /
//     originator / OAI-Product-Sku headers alongside the bearer.
// A preset baseUrl (relay / Azure) overrides the resolved default in either mode.

import { isTauri } from "@/lib/tauri"
import {
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  listPresets,
} from "@/lib/subscription/core/transport"
import { isCodexCredentialFresh } from "./oauth"
import { refreshCodexAccountIfStale } from "./refresh"
import {
  CODEX_CHATGPT_BASE_URL,
  CODEX_DEFAULT_API_BASE_URL,
  isCodexChatProviderId,
} from "@/types/subscription"
import type { Account, AccountSummary, ProviderPreset } from "@/types/subscription"

export interface CodexVaultCredential {
  apiKey: string
  baseURL: string
  /** Extra headers required by the ChatGPT-login backend (empty for api_key). */
  headers?: Record<string, string>
}

/**
 * Resolve a usable credential for the Codex chat provider from the subscription
 * vault. Returns `null` when the id isn't "codex", outside Tauri (vault is
 * desktop-only), when no account exists, when the stored credential has no
 * usable token, or on any transport error — callers treat `null` as "no
 * fallback available".
 */
export async function resolveCodexVaultCredential(
  providerId: string
): Promise<CodexVaultCredential | null> {
  if (!isCodexChatProviderId(providerId)) return null
  if (!isTauri()) return null
  try {
    const [summaries, active] = await Promise.all([
      listAccounts("codex"),
      getActiveAccount("codex").catch(() => null),
    ])
    const candidate = pickAccount(summaries, active?.activeAccountId)
    if (!candidate) return null
    const full = await getAccount("codex", candidate.id)
    if (!full || full.credential.provider !== "codex") return null

    // Renew a near-expiry ChatGPT bearer before handing it to the provider. The
    // external-agent spawn path has always done this; chat never did, so a
    // reused ChatGPT subscription 401'd once its token aged out even though the
    // vault held a usable refresh token.
    //
    // The freshness pre-check is what keeps this off the hot path: this resolver
    // runs on EVERY turn, and `refreshCodexAccountIfStale` re-reads the account
    // over IPC before deciding. Skipping the call outright for the overwhelmingly
    // common fresh/api_key case avoids a round-trip per turn; the helper repeats
    // the check internally against the freshly-read credential, so this is a
    // fast path, not the safety guarantee.
    //
    // A failed refresh degrades to the stored token (which may still work, and
    // otherwise 401s with the provider's own message) rather than killing the
    // turn with no credential at all.
    const credential = isCodexCredentialFresh(full.credential)
      ? full.credential
      : ((await refreshCodexAccountIfStale(candidate.id).catch(() => null)) ?? full.credential)
    const apiKey = credential.accessToken?.trim()
    if (!apiKey) return null

    const preset = await resolvePresetFor(full)
    const presetBase = preset?.baseUrl?.trim()

    if (credential.authMode === "chatgpt") {
      const headers: Record<string, string> = {
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "OAI-Product-Sku": "codex",
        "User-Agent": "codex-cli",
      }
      const accountId = credential.accountId?.trim()
      if (accountId) headers["ChatGPT-Account-Id"] = accountId
      return {
        apiKey,
        baseURL: presetBase || CODEX_CHATGPT_BASE_URL,
        headers,
      }
    }

    // api_key mode: standard OpenAI.
    return { apiKey, baseURL: presetBase || CODEX_DEFAULT_API_BASE_URL }
  } catch {
    return null
  }
}

/**
 * Resolve the preset an account draws its relay config from: the account's own
 * binding first, the provider-level default otherwise (same order as the Rust
 * `ProviderVault::resolve_preset`). Errors degrade to "no preset".
 */
async function resolvePresetFor(account: Account): Promise<ProviderPreset | null> {
  try {
    if (account.presetId) {
      const bound = (await listPresets("codex")).find((p) => p.id === account.presetId)
      if (bound) return bound
    }
    return await getProviderPreset("codex")
  } catch {
    return null
  }
}

/**
 * Pick the vault account to draw the credential from: the active account wins,
 * then the most recently used. Only "codex"-variant accounts are considered.
 */
function pickAccount(summaries: AccountSummary[], activeAccountId?: string): AccountSummary | null {
  const matching = summaries.filter((s) => s.variant === "codex")
  const active = activeAccountId ? matching.find((s) => s.id === activeAccountId) : undefined
  if (active) return active
  matching.sort((a, b) => (b.lastUsedAtMs ?? 0) - (a.lastUsedAtMs ?? 0))
  return matching[0] ?? null
}
