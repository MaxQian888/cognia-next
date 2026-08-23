import { MCP_PRESETS, type McpPreset } from "@/lib/claude/mcp-presets"
import { listMcpServerPresetEntries } from "@/lib/plugin/registries/mcp-server-preset-registry"

/** Static curated presets followed by enabled plugin contributions; static ids cannot be shadowed. */
export function listMcpPresetCatalog(): McpPreset[] {
  const ids = new Set(MCP_PRESETS.map((preset) => preset.id))
  const dynamic = listMcpServerPresetEntries().flatMap(({ id, entry }) => {
    if (ids.has(id)) return []
    ids.add(id)
    return [
      {
        id,
        name: entry.name,
        description: entry.description ?? "",
        icon: entry.icon ?? "🔌",
        transport: entry.transport,
        config: entry.config,
        fields: entry.fields ?? [],
        defaultDisallowedTools: entry.defaultDisallowedTools,
        docsUrl: entry.docsUrl,
        tags: entry.tags,
      },
    ] satisfies McpPreset[]
  })
  return [...MCP_PRESETS, ...dynamic]
}
