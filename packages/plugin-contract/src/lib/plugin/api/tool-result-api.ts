/**
 * The plugin contract's share of `lib/plugin/api/tool-result-api.ts`, which re-exports these.
 */
import type React from "react"
import type { ToolResultRendererProps } from "./tool-result-renderers"

export interface PluginToolResultAPI {
  /**
   * Register the result card for a tool this plugin provides. Returns an
   * unregister callback; the host also purges on plugin disable, so manual
   * cleanup is belt-and-braces.
   *
   * `toolName` is the bare name (`my_tool`) — the host folds the provider's
   * namespaced form (`mcp__cognia-plugin-tools__my_tool`) onto it, so one
   * registration covers every execution path.
   *
   * The component receives the whole tool part, including `mcpContent` when
   * the result carried structured MCP blocks. Return `null` to decline a
   * payload you can't render; the host then falls back to its generic card.
   */
  registerToolResultRenderer: (
    toolName: string,
    component: React.ComponentType<ToolResultRendererProps>
  ) => () => void
}
