/**
 * Balance Adapter Registry — dynamic overlay for plugin-contributed
 * subscription balance adapters.
 *
 * Plugins shipping the `balance-adapter` capability call
 * `registerBalanceAdapter` on enable through the `OVERLAY_REGISTRY_CAPABILITIES`
 * dispatch loop in `lib/plugin/core/manager.ts`. On disable the manager calls
 * `unregisterBalanceAdaptersByPlugin(pluginId)`.
 *
 * Consumer: `findBalanceAdapter` (`lib/subscription/balance/registry.ts`) lists
 * these overlay adapters BEFORE the built-in array, so a plugin can extend or
 * override the bundled set.
 */

import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginBalanceAdapterDef>({
  name: "balance-adapter",
})

/** Register a plugin-contributed balance adapter. */
export const registerBalanceAdapter = registry.register
/** Drop a single dynamically-registered adapter by id. */
export const unregisterBalanceAdapterById = registry.unregisterById
/** Drop every adapter contributed by `pluginId`. Returns the number removed. */
export const unregisterBalanceAdaptersByPlugin = registry.unregisterByPlugin
/** Get an adapter by id. Returns undefined when not registered. */
export const getBalanceAdapter = registry.get
/** Get the full registry entry (adapter + pluginId tag) for an id. */
export const getBalanceAdapterEntry = registry.getEntry
/** List every registered adapter id in registration order. */
export const listBalanceAdapterIds = registry.list
/** List every registered entry (id + adapter + pluginId) in registration order. */
export const listBalanceAdapterEntries = registry.entries
/** Test-only: clear every dynamically registered adapter. */
export const __resetBalanceAdaptersForTesting = registry.__resetForTesting
