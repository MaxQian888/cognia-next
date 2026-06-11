/**
 * Plugin Balance Adapter contract (`balance-adapter` capability).
 *
 * Opens the subscription balance-adapter registry to plugins. A built-in set of
 * adapters (`lib/subscription/balance/adapters/*`) already resolves balances for
 * providers with a public balance API; a plugin can contribute another (or
 * override a built-in) by shipping a `balanceAdapters[]` manifest entry.
 *
 * Adapters are PURE (the same contract the built-ins satisfy): they only
 * describe an authed GET request and parse its body. The Tauri-side
 * `subscription_authed_get` performs the actual HTTP, so adapters never touch
 * the network or hit CORS. Consumed by `findBalanceAdapter`
 * (`lib/subscription/balance/registry.ts`), which checks plugin adapters before
 * the built-ins.
 */

import type { BalanceAdapter } from "@/types/subscription"

export interface PluginBalanceAdapterDef extends BalanceAdapter {
  /**
   * Stable registry id (e.g. `<pluginId>:<adapter>`). Distinct from `key`,
   * which is the provider-match token the runner resolves against a preset's
   * `templateId` / baseUrl host.
   */
  id: string
  /** Optional display name for diagnostics and the plugin capability summary. */
  name?: string
}
