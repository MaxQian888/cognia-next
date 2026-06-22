/**
 * Plugin SDK helper for the `balance-adapter` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineBalanceAdapter()` checks the shape (a pure `BalanceAdapter` —
 * key/matches/request/parse — plus a registry `id`) against
 * `PluginBalanceAdapterDef`. Adapters never touch the network; the Tauri-side
 * `subscription_authed_get` performs the HTTP.
 */

import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"

export function defineBalanceAdapter(def: PluginBalanceAdapterDef): PluginBalanceAdapterDef {
  return def
}
