/**
 * Compaction Strategy Registry — dynamic overlay for plugin-contributed
 * conversation-compaction strategies (`compaction-strategy` capability).
 *
 * Plugins shipping the capability call `registerCompactionStrategy` on enable
 * through the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the manager calls
 * `unregisterCompactionStrategiesByPlugin(pluginId)`.
 *
 * Consumer: `resolveSendOptions` (`lib/claude/build-options.ts`) reads the
 * active `strategyId` from the compaction settings, looks it up here, and
 * threads the strategy's declarative `{ summaryPrompt, keepRecent, fraction }`
 * into `SendOptions.compaction`. The built-in default (no plugin) lives in
 * `lib/claude/compact-instructions.ts`.
 */

import type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginCompactionStrategyDef>({
  name: "compaction-strategy",
})

/** Register a plugin-contributed compaction strategy. */
export const registerCompactionStrategy = registry.register
/** Drop a single dynamically-registered strategy by id. */
export const unregisterCompactionStrategyById = registry.unregisterById
/** Drop every strategy contributed by `pluginId`. Returns the number removed. */
export const unregisterCompactionStrategiesByPlugin = registry.unregisterByPlugin
/** Get a strategy by id. Returns undefined when not registered. */
export const getCompactionStrategy = registry.get
/** Get the full registry entry (strategy + pluginId tag) for an id. */
export const getCompactionStrategyEntry = registry.getEntry
/** List every registered strategy id in registration order. */
export const listCompactionStrategyIds = registry.list
/** List every registered entry (id + strategy + pluginId) in registration order. */
export const listCompactionStrategyEntries = registry.entries
/** Test-only: clear every dynamically registered strategy. */
export const __resetCompactionStrategiesForTesting = registry.__resetForTesting
