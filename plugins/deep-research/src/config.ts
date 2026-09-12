/**
 * Engine budgets, read from the plugin's own declarative configuration.
 *
 * `ctx.configuration` (not a raw `ctx.config` bag) because it seeds the
 * manifest's schema defaults: a fresh install has never written a config row,
 * and reading raw storage there returns `undefined` for every budget — which
 * silently ran the loop on the engine's internal defaults instead of the ones
 * the manifest advertises to the user.
 *
 * The flip side of seeding: every key is ALWAYS present, so a returned value
 * cannot tell "user set this" from "schema shipped this". That distinction is
 * what lets the `deep_research` tool's `depth` preset coexist with user
 * tuning — the preset is supposed to win over defaults but lose to explicit
 * choices. This function therefore returns only values that DIVERGE from the
 * declared defaults; a value equal to its default is indistinguishable from
 * never-touched and treated as unset.
 *
 * Search-provider credentials are deliberately absent. Search and page reads go
 * through the host's promoted web tools, so the provider and its key live in
 * Settings → Search, configured once for the whole app.
 */
import type { PluginContext } from "@cognia/plugin-sdk"

import type { DeepSearchConfig } from "./types"
import { DEFAULT_CONFIG } from "./types"
import manifestJson from "../plugin.json"

export const PLUGIN_ID = "cognia-deep-research"

interface ManifestConfigBits {
  defaultConfig?: Record<string, unknown>
  configSchema?: { properties?: Record<string, { default?: unknown }> }
}

const manifest = manifestJson as ManifestConfigBits

/**
 * What the host would have seeded for `key` — the exact precedence of
 * `seedPluginConfigDefaults`: `defaultConfig` over `configSchema` property
 * defaults, with the engine's own constant as the last resort.
 */
function declaredDefault(key: keyof DeepSearchConfig): unknown {
  if (manifest.defaultConfig && Object.prototype.hasOwnProperty.call(manifest.defaultConfig, key)) {
    return manifest.defaultConfig[key]
  }
  const prop = manifest.configSchema?.properties?.[key]
  if (prop && Object.prototype.hasOwnProperty.call(prop, "default")) return prop.default
  return DEFAULT_CONFIG[key]
}

/** Numeric budgets accepted from configuration, in manifest order. */
const NUMERIC_KEYS = [
  "tokenBudget",
  "maxSteps",
  "maxBadAttempts",
  "readTopK",
  "searchResultsPerQuery",
] as const satisfies ReadonlyArray<keyof DeepSearchConfig>

/**
 * Engine overrides drawn from plugin configuration. Absent, non-numeric,
 * non-positive — or equal-to-default — values fall through to the caller's
 * base (a depth preset or `DEFAULT_CONFIG`) rather than poisoning a budget
 * with `NaN`/`0` (a zero step ceiling ends the run before it starts) or
 * silently pinning the preset (a seeded default is not a user choice).
 */
export function readEngineConfig(ctx: PluginContext): Partial<DeepSearchConfig> {
  const config = ctx.configuration.getAll()
  const out: Partial<DeepSearchConfig> = {}
  for (const key of NUMERIC_KEYS) {
    const value = config[key]
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value !== declaredDefault(key)
    ) {
      ;(out[key] as number) = value
    }
  }
  const locale = config.locale
  if (typeof locale === "string" && locale.trim()) out.locale = locale.trim()
  return out
}
