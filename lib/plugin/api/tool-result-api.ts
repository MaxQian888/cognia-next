/**
 * Plugin Tool-Result Renderer API.
 *
 * Lets a plugin contribute the React card that renders ITS OWN MCP tool's
 * result inside a chat message. Mirrors `createMessagePartAPI(pluginId)` so the
 * two renderer surfaces feel consistent.
 *
 * Precedence, and why there is no reserved-name list here: the host's built-in
 * card table (`components/chat/message-parts/mcp-tool-card.tsx`) is consulted
 * FIRST, so a plugin can never shadow `Read` / `Grep` / `WebSearch` / … no
 * matter what it registers. That ordering is the actual guarantee. Duplicating
 * the built-in tool names into this module would only add a second list to
 * drift out of sync with the first — the failure mode this repo keeps paying
 * for. Registering a host-owned name is therefore harmless but inert, and the
 * warning below says so.
 */

import { createPluginSystemLogger } from "../core/logger"
import {
  clearToolResultRenderersForPlugin,
  registerToolResultRenderer,
  toolResultRendererKey,
  type ToolResultRendererProps,
} from "./tool-result-renderers"
import type React from "react"

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

export function createToolResultAPI(pluginId: string): PluginToolResultAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerToolResultRenderer: (toolName, component) => {
      const key = typeof toolName === "string" ? toolResultRendererKey(toolName.trim()) : ""
      if (!key) {
        logger.warn(`[toolResult] refusing to register a renderer for an empty tool name`)
        return () => {}
      }
      const unregister = registerToolResultRenderer(pluginId, key, component)
      logger.info(
        `[toolResult] registered renderer for "${key}" (inert if the host ships a built-in card for it)`
      )
      return () => {
        unregister()
        logger.info(`[toolResult] unregistered renderer for "${key}"`)
      }
    },
  }
}

/**
 * Plugin-disable hook — drop every tool-result renderer the plugin owns.
 */
export function purgeToolResultRenderersForPlugin(pluginId: string): void {
  clearToolResultRenderersForPlugin(pluginId)
}
