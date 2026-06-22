/**
 * Plugin SDK — `im-rate-source` capability surface.
 *
 * Re-exports the authoring helper and overlay registry plugins use to
 * contribute per-conversation IM send gates dynamically at activation time.
 */

export { defineImRateSource } from "../define/define-im-rate-source"

export {
  registerImRateSource,
  unregisterImRateSourceById,
  unregisterImRateSourcesByPlugin,
  getImRateSource,
  getImRateSourceEntry,
  listImRateSourceIds,
  listImRateSourceEntries,
} from "@/lib/plugin/registries/im-rate-source-registry"

export type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
