/**
 * Engine budgets, read from the plugin's own declarative configuration.
 *
 * `ctx.configuration` (not a raw `ctx.config` bag) because it seeds the
 * manifest's schema defaults: a fresh install has never written a config row,
 * and reading raw storage there returns `undefined` for every budget — which
 * silently ran the loop on the engine's internal defaults instead of the ones
 * the manifest advertises to the user.
 *
 * Search-provider credentials are deliberately absent. Search and page reads go
 * through the host's promoted web tools, so the provider and its key live in
 * Settings → Search, configured once for the whole app.
 */
import type { PluginContext } from "@cognia/plugin-sdk"

import type { DeepSearchConfig } from "./types"

export const PLUGIN_ID = "cognia-deep-research"

/** Numeric budgets accepted from configuration, in manifest order. */
const NUMERIC_KEYS = [
  "tokenBudget",
  "maxSteps",
  "maxBadAttempts",
  "readTopK",
  "searchResultsPerQuery",
] as const satisfies ReadonlyArray<keyof DeepSearchConfig>

/**
 * Engine overrides drawn from plugin configuration. Absent, non-numeric or
 * non-positive values fall through to `DEFAULT_CONFIG` rather than poisoning a
 * budget with `NaN` or `0` (a zero step ceiling ends the run before it starts).
 */
export function readEngineConfig(ctx: PluginContext): Partial<DeepSearchConfig> {
  const config = ctx.configuration.getAll()
  const out: Partial<DeepSearchConfig> = {}
  for (const key of NUMERIC_KEYS) {
    const value = config[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      ;(out[key] as number) = value
    }
  }
  const locale = config.locale
  if (typeof locale === "string" && locale.trim()) out.locale = locale.trim()
  return out
}
