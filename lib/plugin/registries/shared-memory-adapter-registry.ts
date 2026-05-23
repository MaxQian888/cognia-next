/**
 * Shared-Memory Adapter Registry — dynamic overlay for plugin-contributed
 * agent-team shared-memory backing stores.
 *
 * Plugins shipping the `shared-memory-adapter` capability call
 * `registerSharedMemoryAdapter` on enable through the
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in `lib/plugin/core/manager.ts`.
 * On disable the manager calls `unregisterSharedMemoryAdaptersByPlugin(pluginId)`.
 *
 * Consumers:
 *   - `lib/ai/agent/team/shared-memory-orchestrator.ts` — mirror writes +
 *     `syncSharedMemoryFromAdapter` reverse pull.
 *   - the workspace Memory section adapter strip (picker + "Sync now").
 */

import type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginSharedMemoryAdapterDef>({
  name: "shared-memory-adapter",
})

/** Register a plugin-contributed shared-memory adapter. */
export const registerSharedMemoryAdapter = registry.register
/** Drop a single dynamically-registered adapter by id. */
export const unregisterSharedMemoryAdapterById = registry.unregisterById
/** Drop every adapter contributed by `pluginId`. Returns the number removed. */
export const unregisterSharedMemoryAdaptersByPlugin = registry.unregisterByPlugin
/** Get an adapter by id. Returns undefined when not registered. */
export const getSharedMemoryAdapter = registry.get
/** Get the full registry entry (adapter + pluginId tag) for an id. */
export const getSharedMemoryAdapterEntry = registry.getEntry
/** List every registered adapter id in registration order. */
export const listSharedMemoryAdapterIds = registry.list
/** List every registered entry (id + adapter + pluginId) in registration order. */
export const listSharedMemoryAdapterEntries = registry.entries
/** Test-only: clear every dynamically registered adapter. */
export const __resetSharedMemoryAdaptersForTesting = registry.__resetForTesting
