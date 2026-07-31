/**
 * MCP preset catalog for the CLI `/mcp presets` gallery and `/mcp add --preset`.
 * Merges the static built-in catalog (`MCP_PRESETS`) with presets contributed
 * by enabled plugins (`manifest.mcpServerPresets`, read from disk via
 * `discoverPlugins`). Presets are templates: the user instantiates one by
 * filling its fields, which `applyPresetFields` plugs into the config — the same
 * instantiation path the desktop gallery uses, so behavior stays identical.
 */
import {
  applyPresetFields,
  MCP_PRESETS,
  type McpPreset,
  type McpPresetField,
} from "@/lib/claude/mcp-presets"
import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"

import { discoverPlugins, type PluginFs } from "../plugin/discover-plugins"
import { readDisabledPlugins } from "../plugin/plugin-state"

export interface CatalogPreset {
  preset: McpPreset
  /** "built-in" for the static catalog, or `plugin:<id>` for a plugin entry. */
  source: string
}

/** Normalize a plugin preset def into the unified `McpPreset` shape. */
export function normalizePluginPreset(def: PluginMcpServerPresetDef): McpPreset {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? "",
    icon: def.icon ?? "🧩",
    transport: def.transport,
    config: def.config,
    fields: def.fields ?? [],
    ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
    ...(def.tags ? { tags: def.tags } : {}),
  }
}

export interface CollectPresetsOpts {
  roots: string[]
  home: string
  fs?: PluginFs
  /** Override the disabled-plugin reader (tests). */
  readDisabled?: (home: string) => Set<string>
}

/**
 * The full preset gallery: built-ins first, then presets from every enabled
 * plugin. A plugin whose id is in the disabled overlay contributes nothing.
 */
export async function collectMcpPresets(opts: CollectPresetsOpts): Promise<CatalogPreset[]> {
  const out: CatalogPreset[] = MCP_PRESETS.map((preset) => ({ preset, source: "built-in" }))
  const disabled = (opts.readDisabled ?? readDisabledPlugins)(opts.home)
  const plugins = await discoverPlugins(opts.roots, opts.fs)
  for (const plugin of plugins) {
    if (disabled.has(plugin.id)) continue
    for (const def of plugin.mcpServerPresets) {
      out.push({ preset: normalizePluginPreset(def), source: `plugin:${plugin.id}` })
    }
  }
  return out
}

/** Find a catalog preset by id (built-ins win ties, plugins fill the rest). */
export function findCatalogPreset(catalog: CatalogPreset[], id: string): CatalogPreset | undefined {
  return catalog.find((c) => c.preset.id === id)
}

/** Field keys the user must supply — every field except optional headers. */
export function requiredFieldKeys(preset: McpPreset): string[] {
  return preset.fields.filter((f) => f.placement !== "header").map((f) => f.key)
}

/** The required fields the user hasn't provided a non-empty value for. */
export function missingPresetFields(
  preset: McpPreset,
  values: Record<string, string>
): McpPresetField[] {
  return preset.fields.filter(
    (f) => f.placement !== "header" && !(values[f.key] && values[f.key].trim())
  )
}

export { applyPresetFields }
