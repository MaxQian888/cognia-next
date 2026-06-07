// Subscription-vault → chat-provider bridge for the OpenCode managed plans.
//
// The "opencode" / "opencode-go" built-in chat providers normally read their
// API key from Settings → Providers. When the user never configured one,
// `resolveSendOptions` falls back here: the active (or best-matching) account
// in the OpenCode subscription vault supplies the key, so a pasted Zen/Go
// subscription key is immediately usable in chat with zero extra setup —
// the same convenience the Anthropic subscription path already has.
//
// Plan matching: the vault stores Zen and Go accounts side by side under the
// single "opencode" provider. The chat-provider id picks which plan we want
// ("opencode" → zen, "opencode-go" → go); the active account wins when its
// plan matches, otherwise the most recently used matching account does.

import { isTauri } from "@/lib/tauri"
import { getAccount, getActiveAccount, listAccounts } from "@/lib/subscription/core/transport"
import type { AccountSummary } from "@/types/subscription"
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
  providerId: string
): Promise<OpencodeVaultCredential | null> {
  if (!isOpencodeChatProviderId(providerId)) return null
  if (!isTauri()) return null
  const wantPlan = planForOpencodeChatProvider(providerId)
  try {
    const [summaries, active] = await Promise.all([
      listAccounts("opencode"),
      getActiveAccount("opencode").catch(() => null),
    ])
    const candidate = pickAccount(summaries, wantPlan, active?.activeAccountId)
    if (!candidate) return null
    const full = await getAccount("opencode", candidate.id)
    if (!full || full.credential.provider !== "opencode-zen") return null
    const apiKey = full.credential.accessToken?.trim()
    if (!apiKey) return null
    const baseURL = full.credential.baseUrl?.trim() || opencodeDefaultBaseUrl(wantPlan)
    return { apiKey, baseURL }
  } catch {
    return null
  }
}

/**
 * Pick the vault account to draw the key from: paste-key accounts only
 * (discovery rows carry no adoptable secret), plan must match, the active
 * account wins, then most recently used. The Rust side defaults a missing
 * plan to "zen".
 */
function pickAccount(
  summaries: AccountSummary[],
  wantPlan: "zen" | "go",
  activeAccountId?: string
): AccountSummary | null {
  const matching = summaries.filter(
    (s) => s.variant === "opencode-zen" && (s.plan ?? "zen") === wantPlan
  )
  const active = activeAccountId ? matching.find((s) => s.id === activeAccountId) : undefined
  if (active) return active
  matching.sort((a, b) => (b.lastUsedAtMs ?? 0) - (a.lastUsedAtMs ?? 0))
  return matching[0] ?? null
}
