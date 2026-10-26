/**
 * Plugin Message Part Renderer API.
 *
 * Lets a plugin contribute a React component that renders custom
 * `UIMessage.parts[i].type` values inside the chat message renderer. Mirrors
 * the shape of `createArtifactAPI(pluginId).registerRenderer(...)` so the two
 * surfaces feel consistent.
 */

import { createPluginSystemLogger } from "../core/logger"
import {
  clearMessagePartRenderersForPlugin,
  registerMessagePartRenderer,
} from "./message-part-renderers"
import type { PluginMessagePartAPI } from "@cognia/plugin-contract/lib/plugin/api/message-part-api"
export type { PluginMessagePartAPI } from "@cognia/plugin-contract/lib/plugin/api/message-part-api"

const RESERVED_PREFIXES = ["tool-", "text", "reasoning", "file"]
const RESERVED_TYPES = new Set([
  // The AI SDK's undeclared-tool shape. Routed through the host's tool
  // renderer just like `tool-*`, so it is host-owned for the same reason.
  "dynamic-tool",
  "a2ui",
  "subagent",
  "agent-team-dispatch",
  "artifact",
  "sources",
  "canvas",
])

function isReservedType(type: string): boolean {
  if (!type) return true
  if (RESERVED_TYPES.has(type)) return true
  for (const prefix of RESERVED_PREFIXES) {
    if (type.startsWith(prefix)) return true
  }
  return false
}

export function createMessagePartAPI(pluginId: string): PluginMessagePartAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    registerPartRenderer: (type, component) => {
      if (isReservedType(type)) {
        logger.warn(
          `[messagePart] refusing to register reserved part type "${type}"; pick a plugin-prefixed type`
        )
        return () => {}
      }
      const unregister = registerMessagePartRenderer(pluginId, type, component)
      logger.info(`[messagePart] registered renderer for "${type}"`)
      return () => {
        unregister()
        logger.info(`[messagePart] unregistered renderer for "${type}"`)
      }
    },
  }
}

/**
 * Plugin-disable hook — drop every renderer the plugin owns.
 */
export function purgeMessagePartRenderersForPlugin(pluginId: string): void {
  clearMessagePartRenderersForPlugin(pluginId)
}
