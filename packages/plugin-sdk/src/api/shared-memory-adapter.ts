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
} from "@cognia/plugin-contract/lib/plugin/registries/shared-memory-adapter-registry"

export type { PluginSharedMemoryAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-shared-memory-adapter"

export type { SharedMemoryAdapterChangeSet } from "@cognia/plugin-contract/types/plugin/plugin-shared-memory-adapter"

/** The host's shared-memory row shape an adapter reads and writes. */
export type { SharedMemoryEntry } from "@cognia/plugin-contract/types/agent/agent-team"
