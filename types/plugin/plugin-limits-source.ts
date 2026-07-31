/**
 * Plugin Limits Source contract (`limits-source` capability).
 *
 * Opens the unified subscription limits/usage registry to plugins. A built-in
 * set of sources (`lib/subscription/limits/sources/*`) already resolves limits
 * for Anthropic (windows), Codex (windows, best-effort) and every credit-based
 * provider (via the balance adapters). A plugin can contribute another (or
 * override a built-in) by shipping a `limitsSources[]` manifest entry.
 *
 * Sources mirror the contract the built-ins satisfy: `matches` is pure and
 * `fetch` performs the injected authed GET, returning a normalized
 * `ProviderLimits` (or `null` when the source doesn't apply). Consumed by
 * `resolveLimitsSources` (`lib/subscription/limits/registry.ts`), which checks
 * plugin sources before the built-ins.
 */

import type { LimitsSource } from "@/types/subscription"

export interface PluginLimitsSourceDef extends LimitsSource {
  /**
   * Stable registry id (e.g. `<pluginId>:<source>`). Distinct from `key`,
   * which is the provider-match token the runner resolves against.
   */
  id: string
  /** Optional display name for diagnostics and the plugin capability summary. */
  name?: string
}
