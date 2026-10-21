/**
 * Plugin SDK — `tool-route` capability surface.
 *
 * Exports the authoring helper and the tool-route types consumed by plugin
 * tool routing. The host registers manifest-declared routes and persists
 * them itself.
 */

export { defineToolRoute } from "../define/define-tool-route"

export type { ToolRoutesBridgeResult } from "@cognia/plugin-contract/lib/plugin/bridge/tool-routes-bridge"

export type { PluginToolRouteDef } from "@cognia/plugin-contract/types/plugin/plugin-tool-route"

export {
  DEFAULT_DIFFICULTY_ROUTING,
  DEFAULT_SEMANTIC_TOOL_ROUTING,
} from "@cognia/plugin-contract/types/routing/tool-route"

export type {
  DifficultyRoutingSettings,
  SemanticToolRoutingSettings,
  ToolRouteRecord,
} from "@cognia/plugin-contract/types/routing/tool-route"
