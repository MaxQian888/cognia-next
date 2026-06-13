/**
 * Limits Source Registry — dynamic overlay for plugin-contributed subscription
 * limits/usage sources (`limits-source` capability).
 *
 * Plugins shipping the `limits-source` capability call `registerLimitsSource`
 * on enable through the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the manager calls
 * `unregisterLimitsSourcesByPlugin(pluginId)`.
 *
 * Consumer: `resolveLimitsSources` (`lib/subscription/limits/registry.ts`) lists
 * these overlay sources BEFORE the built-in array, so a plugin can extend or
 * override the bundled set. Sibling of the `balance-adapter` registry.
 */

import type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginLimitsSourceDef>({
  name: "limits-source",
})

/** Register a plugin-contributed limits source. */
export const registerLimitsSource = registry.register
/** Drop a single dynamically-registered source by id. */
export const unregisterLimitsSourceById = registry.unregisterById
/** Drop every source contributed by `pluginId`. Returns the number removed. */
export const unregisterLimitsSourcesByPlugin = registry.unregisterByPlugin
/** Get a source by id. Returns undefined when not registered. */
export const getLimitsSource = registry.get
/** Get the full registry entry (source + pluginId tag) for an id. */
export const getLimitsSourceEntry = registry.getEntry
/** List every registered source id in registration order. */
export const listLimitsSourceIds = registry.list
/** List every registered entry (id + source + pluginId) in registration order. */
export const listLimitsSourceEntries = registry.entries
/** Test-only: clear every dynamically registered source. */
export const __resetLimitsSourcesForTesting = registry.__resetForTesting
