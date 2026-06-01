/**
 * Config + secret reading. The only host type used is `PluginContext`
 * (types-only import) — no behavioural coupling to the core app.
 */
import type { PluginContext } from "@/types/plugin"
import type { SearchProviderId } from "./providers/search"
import type { DeepSearchConfig } from "./types"

export const PLUGIN_ID = "cognia-deep-research"

/** Keyring id for a provider's API key, e.g. `cognia-deep-research:exaKey`. */
export function secretKey(provider: SearchProviderId): string {
  return `${PLUGIN_ID}:${provider}Key`
}

function cfg(ctx: PluginContext): Record<string, unknown> {
  return (ctx.config as Record<string, unknown> | undefined) ?? {}
}

export function readSearchProvider(ctx: PluginContext): SearchProviderId {
  const value = cfg(ctx).searchProvider
  return value === "tavily" ? "tavily" : "exa"
}

/**
 * Resolve a provider API key: the secure keyring first, then a plain-config
 * fallback (handy in web/dev where the keyring degrades to localStorage).
 */
export async function readApiKey(
  ctx: PluginContext,
  provider: SearchProviderId
): Promise<string | null> {
  try {
    const fromSecret = await ctx.secrets?.get?.(secretKey(provider))
    if (fromSecret && fromSecret.trim()) return fromSecret.trim()
  } catch {
    // keyring unavailable — fall back to config
  }
  const fromConfig = cfg(ctx)[`${provider}ApiKey`]
  return typeof fromConfig === "string" && fromConfig.trim() ? fromConfig.trim() : null
}

/** Engine config overrides drawn from plugin config (absent keys use defaults). */
export function readEngineConfig(ctx: PluginContext): Partial<DeepSearchConfig> {
  const c = cfg(ctx)
  const out: Partial<DeepSearchConfig> = {}
  const numbers: (keyof DeepSearchConfig)[] = [
    "tokenBudget",
    "maxSteps",
    "maxBadAttempts",
    "readTopK",
    "searchResultsPerQuery",
  ]
  for (const key of numbers) {
    const v = c[key]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      ;(out[key] as number) = v
    }
  }
  if (typeof c.locale === "string" && c.locale.trim()) out.locale = c.locale.trim()
  return out
}
