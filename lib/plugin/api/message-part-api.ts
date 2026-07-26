/**
 * Plugin Message Part Renderer API.
 *
 * Lets a plugin contribute a React component that renders custom
 * `UIMessage.parts[i].type` values inside the chat message renderer. Mirrors
 * the shape of `createArtifactAPI(pluginId).registerRenderer(...)` so the two
 * surfaces feel consistent.
 */

import type React from "react"
import { createPluginSystemLogger } from "../core/logger"
import {
  clearMessagePartRenderersForPlugin,
  registerMessagePartRenderer,
  type MessagePartRendererProps,
} from "./message-part-renderers"

export interface PluginMessagePartAPI {
  /**
   * Register a renderer for a custom `part.type`. Returns an unregister
   * callback. The plugin host also calls `clearMessagePartRenderersForPlugin`
   * on plugin disable, so manual cleanup is a belt-and-braces step rather
   * than a hard requirement.
   *
   * Constraint — `type` cannot start with `tool-`, `text`, `reasoning`,
   * `file`, or be `dynamic-tool`, `a2ui`, `subagent`, `agent-team-dispatch`,
   * `artifact`, `sources`, or `canvas` (those are owned by the host). The
   * function returns a noop unregister for invalid types and logs a warning.
   */
  registerPartRenderer: (
    type: string,
    component: React.ComponentType<MessagePartRendererProps>
  ) => () => void
}

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
