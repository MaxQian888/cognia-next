import type { PluginResourceEffectMap } from "./disposable-scope"
import { PLUGIN_API_RESOURCE_EFFECTS } from "@cognia/plugin-sdk/contracts"

/**
 * Canonical ownership metadata generated from the Plugin Interface Catalog.
 * Legacy bridge cleanup remains an idempotent shadow during the migration.
 */
export const PLUGIN_RESOURCE_EFFECTS = PLUGIN_API_RESOURCE_EFFECTS satisfies PluginResourceEffectMap
