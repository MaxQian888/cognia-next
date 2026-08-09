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
import { runCustomLimitsSources } from "@/lib/subscription/limits/custom/runner"

import type { LimitsSourceContext, ProviderId, ProviderLimits } from "@/types/subscription"
import type { ResolvedConfig } from "../../config/schema"

/** Default base URLs for providers the CLI knows by id (preset-less). Covers
 * credit-balance hosts and the Coding Plan quota hosts (glm/minimax/kimi-coding)
 * so a provider configured by id alone still matches its catalog descriptor. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  "kimi-coding": "https://api.kimi.com",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  novita: "https://api.novita.ai/v3/openai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  stepfun: "https://api.stepfun.com/v1",
  glm: "https://api.z.ai",
  minimax: "https://api.minimaxi.com",
}

/** Map a CLI provider id onto the vault `ProviderId` the windowed sources match. */
export function mapCliProvider(id: string): ProviderId {
  if (id === "anthropic") return "anthropic"
  if (id === "openai" || id === "codex" || id === "chatgpt") return "codex"
  // Other providers resolve through the declarative catalog (Coding Plan window
  // sources like glm/minimax/kimi-coding) or the balance fallthrough, both of
  // which match on `providerKey`/`baseUrl` and ignore this field — "opencode" is
  // just a harmless placeholder.
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
  const providerLoads = Object.entries(providers).map(async ([id, p]) => {
    const token = (p?.authToken ?? p?.apiKey) || null
    if (!token) return null

    const provider = mapCliProvider(id)
    const providerKey = id
    const baseUrl = p?.baseURL ?? DEFAULT_BASE_URLS[id]

    const sources = resolveLimitsSources({ provider, providerKey, baseUrl })
    if (sources.length === 0) return null

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
        return snapshot
      }
    }
    return null
  })

  const customSources = deps.config.customLimitsSources ?? []
  const customLoad =
    customSources.length > 0
      ? runCustomLimitsSources(customSources, {
          authedGet: deps.authedGet,
          now: () => deps.now,
        })
      : Promise.resolve([])
  const [providerResults, customSnaps] = await Promise.all([Promise.all(providerLoads), customLoad])
  const results = providerResults.filter(
    (snapshot): snapshot is ProviderLimits => snapshot !== null
  )

  // Guarantee the active provider is always represented, even when it has no
  // usable source or returned no data. Without this, the panel would collapse to
  // "only the providers that happened to return data" (typically a credit
  // provider like DeepSeek), making it look like that provider is always active
  // no matter which one really is.
  const active = deps.activeProvider
  if (active && !results.some((r) => r.accountId === active)) {
    results.push({
      provider: active,
      accountId: active,
      accountLabel: active,
      fetchedAt: deps.now,
      meters: [],
    })
  }

  // Pin the active provider's snapshot first (stable for the rest).
  results.sort((a, b) => {
    const aw = a.accountId === deps.activeProvider ? 0 : 1
    const bw = b.accountId === deps.activeProvider ? 0 : 1
    return aw - bw
  })

  // Append user-defined custom sources (self-contained; own baseUrl + token).
  results.push(...customSnaps)
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
