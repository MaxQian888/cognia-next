/**
 * Plugin SDK — `limits-source` capability surface.
 *
 * Re-exports the authoring helper and overlay registry plugins use to
 * contribute subscription limits/usage sources dynamically at activation time.
 */

export { defineLimitsSource } from "../define/define-limits-source"

export {
  registerLimitsSource,
  unregisterLimitsSourceById,
  unregisterLimitsSourcesByPlugin,
  getLimitsSource,
  getLimitsSourceEntry,
  listLimitsSourceIds,
  listLimitsSourceEntries,
} from "@/lib/plugin/registries/limits-source-registry"

export type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"
