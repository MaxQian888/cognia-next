/**
 * Plugin tools manifest for the SDK sidecar runtime.
 *
 * Iterates the plugin store, surfaces every enabled plugin's tools as a
 * flat array of `{name, description, jsonSchema, pluginId}`. The `execute`
 * function is intentionally stripped — functions don't cross the parent
 * stdio IPC channel. The sidecar uses this manifest to build a
 * `cognia-plugin-tools` MCP server; when the model invokes one of the
 * tools, the sidecar emits a `plugin_tool_exec` event back over stdout
 * and the renderer dispatches it via `handlePluginToolExec`.
 *
 * Mirrors the in-process AI-SDK flow in `agent-integration.ts` so a
 * plugin tool registered ONCE via `ctx.agent.registerTool()` lights up
 * both runtimes without the plugin author wiring anything extra.
 */
import { usePluginStore } from "@/stores/plugin"

export interface PluginToolManifestEntry {
  name: string
  description: string
  jsonSchema: object
  pluginId: string
}

/**
 * Build the plugin-tools manifest from the live plugin store.
 *
 * Only `enabled` plugins contribute tools; plugins without a `tools` array
 * are skipped silently. Tools with no `parametersSchema` fall through to
 * an empty object so the sidecar can build a permissive zod object that
 * still passes the raw args through.
 */
export function buildPluginToolsManifest(): PluginToolManifestEntry[] {
  const store = usePluginStore.getState()
  const result: PluginToolManifestEntry[] = []
  for (const plugin of Object.values(store.plugins)) {
    if (plugin.status !== "enabled") continue
    if (!plugin.tools?.length) continue
    for (const tool of plugin.tools) {
      result.push({
        name: tool.name,
        description: tool.definition.description,
        jsonSchema: tool.definition.parametersSchema ?? {},
        pluginId: plugin.manifest.id,
      })
    }
  }
  return result
}
