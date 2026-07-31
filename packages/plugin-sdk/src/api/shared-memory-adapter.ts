/**
 * Plugin SDK — `shared-memory-adapter` capability surface.
 *
 * Re-exports the authoring helper and overlay registry plugins use to
 * contribute agent-team shared-memory backing stores dynamically at activation
 * time.
 */

export { defineSharedMemoryAdapter } from "../define/define-shared-memory-adapter"

export {
  registerSharedMemoryAdapter,
  unregisterSharedMemoryAdapterById,
  unregisterSharedMemoryAdaptersByPlugin,
  getSharedMemoryAdapter,
  getSharedMemoryAdapterEntry,
  listSharedMemoryAdapterIds,
  listSharedMemoryAdapterEntries,
} from "@/lib/plugin/registries/shared-memory-adapter-registry"

export type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"
