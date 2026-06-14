/**
 * IM Rate Source Registry — dynamic overlay for plugin-contributed
 * per-conversation IM send gates (`im-rate-source` capability).
 *
 * Plugins shipping the `im-rate-source` capability call `registerImRateSource`
 * on enable through the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the manager calls
 * `unregisterImRateSourcesByPlugin(pluginId)`.
 *
 * Consumer: `resolveImRateSources` / `evaluateImRate`
 * (`lib/connectors/im-rate/registry.ts`). Sibling of the `limits-source`
 * registry — same overlay factory, different (IM-scoped) entry shape.
 */

import type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginImRateSourceDef>({
  name: "im-rate-source",
})

/** Register a plugin-contributed IM rate source. */
export const registerImRateSource = registry.register
/** Drop a single dynamically-registered source by id. */
export const unregisterImRateSourceById = registry.unregisterById
/** Drop every source contributed by `pluginId`. Returns the number removed. */
export const unregisterImRateSourcesByPlugin = registry.unregisterByPlugin
/** Get a source by id. Returns undefined when not registered. */
export const getImRateSource = registry.get
/** Get the full registry entry (source + pluginId tag) for an id. */
export const getImRateSourceEntry = registry.getEntry
/** List every registered source id in registration order. */
export const listImRateSourceIds = registry.list
/** List every registered entry (id + source + pluginId) in registration order. */
export const listImRateSourceEntries = registry.entries
/** Test-only: clear every dynamically registered source. */
export const __resetImRateSourcesForTesting = registry.__resetForTesting
