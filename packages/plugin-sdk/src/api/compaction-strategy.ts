/**
 * Plugin SDK — `compaction-strategy` capability surface.
 *
 * Re-exports the authoring helper and overlay registry plugins use to
 * contribute conversation compaction strategies dynamically at activation time.
 */

export { defineCompactionStrategy } from "../define/define-compaction-strategy"

export {
  registerCompactionStrategy,
  unregisterCompactionStrategyById,
  unregisterCompactionStrategiesByPlugin,
  getCompactionStrategy,
  getCompactionStrategyEntry,
  listCompactionStrategyIds,
  listCompactionStrategyEntries,
} from "@/lib/plugin/registries/compaction-strategy-registry"

export type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"
