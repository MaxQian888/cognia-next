/**
 * Subagent Registry — dynamic overlay for plugin-contributed Claude SDK
 * subagents.
 *
 * Plugins shipping the `subagent` capability call `registerSubagent` on
 * enable through the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the plugin manager calls
 * `unregisterSubagentsByPlugin(pluginId)` to drop every subagent the plugin
 * contributed in a single shot.
 *
 * Per-plugin cleanup: `unregisterSubagentsByPlugin(pluginId)`.
 *
 * Runtime resolution lives in
 * `lib/claude/agents/subagents/index.ts:resolveAllSubagents`. It unions the
 * 4 host-bundled subagents (workflow-designer / workflow-debugger /
 * workflow-refactorer / workflow-doc-writer) with the overlay; overlay
 * entries are projected under `<pluginId>:<id>` to avoid colliding with
 * built-in dispatcher names.
 */

import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { createOverlayRegistry } from "./createOverlayRegistry"
import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"

const registry = createOverlayRegistry<PluginSubagentDef>({
  name: "subagent",
  // W4.2: without a conflict policy the default last-wins let plugin B hijack
  // plugin A's subagent id (and unregistering B then dropped A's entry). Mirror
  // the pet registries: the incumbent plugin wins, the rejection is reported.
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: "subagent",
      winnerPluginId: info.existingPluginId,
    })
  },
})

/** Register a plugin-contributed subagent. */
export const registerSubagent = registry.register
/** Drop a single dynamically-registered subagent by id. */
export const unregisterSubagentById = registry.unregisterById
/** Drop every subagent contributed by `pluginId`. Returns the number removed. */
export const unregisterSubagentsByPlugin = registry.unregisterByPlugin
/** Get a subagent by id. Returns undefined when not registered. */
export const getSubagent = registry.get
/** Get the full registry entry (subagent + pluginId tag) for an id. */
export const getSubagentEntry = registry.getEntry
/** List every registered subagent id in registration order. */
export const listSubagentIds = registry.list
/**
 * List every registered entry (id + subagent + pluginId) in registration
 * order. This is the snapshot consumed by `resolveAllSubagents`.
 */
export const listSubagentEntries = registry.entries
/** Test-only: clear every dynamically registered subagent. */
export const __resetSubagentsForTesting = registry.__resetForTesting
