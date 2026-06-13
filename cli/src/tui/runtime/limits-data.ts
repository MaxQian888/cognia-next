/**
 * CLI-side limits enumerator. The desktop reads accounts from the Rust keyring
 * vault (`lib/subscription/limits/aggregate.ts`); the CLI has no Tauri, so it
 * derives "accounts" from its own `~/.cognia/config.json` providers instead.
 * Both feed the SAME source registry + meters, so the unified `/limits` panel
 * renders identically.
 *
 * Each configured provider with a credential is mapped to a `LimitsSourceContext`
 * and run through `resolveLimitsSources` (Anthropic windows, Codex windows, or a
 * credit-balance meter). The active provider's snapshot is pinned first.
 */
import { resolveLimitsSources } from "@/lib/subscription/limits/registry"

import type { LimitsSourceContext, ProviderId, ProviderLimits } from "@/types/subscription"
import type { ResolvedConfig } from "../../config/schema"

/** Default base URLs for credit providers the CLI knows by id (preset-less). */
const DEFAULT_BASE_URLS: Record<string, string> = {
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  novita: "https://api.novita.ai/v3/openai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
}

/** Map a CLI provider id onto the vault `ProviderId` the windowed sources match. */
export function mapCliProvider(id: string): ProviderId {
  if (id === "anthropic") return "anthropic"
  if (id === "openai" || id === "codex" || id === "chatgpt") return "codex"
  // Everything else only ever resolves to a balance source, which ignores the
  // provider field — "opencode" is just a harmless placeholder.
  return "opencode"
}

export interface CliLimitsDeps {
  config: ResolvedConfig
  now: number
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  /** CLI active provider id (`config.provider`) — pinned first. */
  activeProvider?: string
}

/**
 * Resolve the unified limits for every configured CLI provider that carries a
 * credential. Providers with no usable source or no snapshot are dropped. Never
 * throws — a single provider's failure is isolated.
 */
export async function buildCliLimits(deps: CliLimitsDeps): Promise<ProviderLimits[]> {
  const providers = deps.config.providers ?? {}
  const results: ProviderLimits[] = []

  for (const [id, p] of Object.entries(providers)) {
    const token = (p?.authToken ?? p?.apiKey) || null
    if (!token) continue

    const provider = mapCliProvider(id)
    const providerKey = id
    const baseUrl = p?.baseURL ?? DEFAULT_BASE_URLS[id]

    const sources = resolveLimitsSources({ provider, providerKey, baseUrl })
    if (sources.length === 0) continue

    const ctx: LimitsSourceContext = {
      provider,
      accountId: id,
      accountLabel: id,
      token,
      baseUrl,
      providerKey,
      authedGet: deps.authedGet,
      now: deps.now,
    }

    for (const source of sources) {
      let snapshot: ProviderLimits | null
      try {
        snapshot = await source.fetch(ctx)
      } catch {
        snapshot = null
      }
      if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
        results.push(snapshot)
        break
      }
    }
  }

  // Pin the active provider's snapshot first (stable for the rest).
  results.sort((a, b) => {
    const aw = a.accountId === deps.activeProvider ? 0 : 1
    const bw = b.accountId === deps.activeProvider ? 0 : 1
    return aw - bw
  })
  return results
}

/** Plain node-`fetch` authed GET — the CLI has no CORS, so no Tauri passthrough. */
export async function nodeAuthedGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await fetch(url, { headers })
  return await res.text()
}
