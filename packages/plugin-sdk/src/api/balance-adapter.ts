/**
 * Plugin SDK — `balance-adapter` capability surface.
 *
 * Re-exports the authoring helper and overlay registry plugins use to
 * contribute subscription balance adapters dynamically at activation time.
 */

export { defineBalanceAdapter } from "../define/define-balance-adapter"

export {
  registerBalanceAdapter,
  unregisterBalanceAdapterById,
  unregisterBalanceAdaptersByPlugin,
  getBalanceAdapter,
  getBalanceAdapterEntry,
  listBalanceAdapterIds,
  listBalanceAdapterEntries,
} from "@/lib/plugin/registries/balance-adapter-registry"

export type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"
