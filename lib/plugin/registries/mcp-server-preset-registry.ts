/**
 * MCP Server Preset Registry — dynamic overlay for plugin-contributed
 * MCP server presets.
 *
 * This registry is the dynamic half of the §A-3 overlay pattern: plugins
 * shipping the `mcp-server-preset` capability call `registerMcpServerPreset`
 * on enable, and the plugin manager calls
 * `unregisterMcpServerPresetsByPlugin(pluginId)` on disable to drop every
 * entry that plugin contributed in a single shot.
 *
 * The static half is the `MCP_PRESETS` table at `lib/claude/mcp-presets.ts:46`,
 * which ships built-in presets (Playwright, Sequential Thinking, etc.).
 *
 * The merged view (dynamic ⊕ static) is built by callers in
 * `lib/claude/mcp-presets.ts`; the wrapper that composes the two halves
 * lands in M3 of the plugin-first Computer Use plan.
 *
 * Per-plugin cleanup: `unregisterMcpServerPresetsByPlugin(pluginId)`.
 */

import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
import { createOverlayRegistry } from "./createOverlayRegistry"
import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"

const registry = createOverlayRegistry<PluginMcpServerPresetDef>({
  name: "mcp-server-preset",
  // W4.2: without a conflict policy the default last-wins let plugin B hijack
  // plugin A's mcp-server-preset id (and unregistering B then dropped A's entry). Mirror
  // the pet registries: the incumbent plugin wins, the rejection is reported.
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: "mcp-server-preset",
      winnerPluginId: info.existingPluginId,
    })
  },
})

/** Register a plugin-contributed MCP server preset. */
export const registerMcpServerPreset = registry.register
/** Drop a single dynamically-registered preset by id. */
export const unregisterMcpServerPresetById = registry.unregisterById
/** Drop every preset contributed by `pluginId`. Returns the number removed. */
export const unregisterMcpServerPresetsByPlugin = registry.unregisterByPlugin
/** Get a preset by id. Returns undefined when not registered. */
export const getMcpServerPreset = registry.get
/** Get the full registry entry (preset + pluginId tag) for an id. */
export const getMcpServerPresetEntry = registry.getEntry
/** List every registered preset id in registration order. */
export const listMcpServerPresetIds = registry.list
/** List every registered entry (id + preset + pluginId) in registration order. */
export const listMcpServerPresetEntries = registry.entries
/** Test-only: clear every dynamically registered preset. */
export const __resetMcpServerPresetsForTesting = registry.__resetForTesting
