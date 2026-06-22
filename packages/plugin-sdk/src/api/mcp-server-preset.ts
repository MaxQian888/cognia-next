/**
 * Plugin SDK — `mcp-server-preset` capability surface.
 *
 * Re-exports the `defineMcpServerPreset()` authoring helper and the dynamic
 * overlay registry plugins use to contribute MCP server presets to the
 * gallery alongside the host's built-in presets.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-mcp-server-preset.ts`
 *  - `lib/plugin/registries/mcp-server-preset-registry.ts`
 *  - `types/plugin/plugin-mcp-preset.ts`
 *
 * The merged view (dynamic ⊕ static) is built by the host in
 * `lib/claude/mcp-presets.ts`. Plugins call `registerMcpServerPreset()`
 * during `activate(ctx)`; the host calls `unregisterMcpServerPresetsByPlugin()`
 * on disable.
 */

export { defineMcpServerPreset } from "../define/define-mcp-server-preset"

export {
  registerMcpServerPreset,
  unregisterMcpServerPresetById,
  unregisterMcpServerPresetsByPlugin,
  getMcpServerPreset,
  getMcpServerPresetEntry,
  listMcpServerPresetIds,
  listMcpServerPresetEntries,
} from "@/lib/plugin/registries/mcp-server-preset-registry"

export type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
