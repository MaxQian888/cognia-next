/**
 * Plugin SDK — `tool-route` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, and persisted semantic
 * tool-route helpers consumed by plugin tool routing.
 */

export { defineToolRoute } from "../define/define-tool-route"

export {
  registerToolRoutesForPlugin,
  unregisterToolRoutesForPlugin,
} from "@/lib/plugin/bridge/tool-routes-bridge"

export type { ToolRoutesBridgeResult } from "@/lib/plugin/bridge/tool-routes-bridge"

export {
  cacheToolRouteEmbeddings,
  deleteToolRoute,
  deleteToolRoutesByPlugin,
  getToolRoute,
  listEnabledToolRoutes,
  listToolRoutes,
  makeToolRouteId,
  upsertToolRoute,
} from "@/lib/db/tool-routes"

export type { PluginToolRouteDef } from "@/types/plugin/plugin-tool-route"

export {
  DEFAULT_DIFFICULTY_ROUTING,
  DEFAULT_SEMANTIC_TOOL_ROUTING,
} from "@/types/routing/tool-route"

export type {
  DifficultyRoutingSettings,
  SemanticToolRoutingSettings,
  ToolRouteRecord,
} from "@/types/routing/tool-route"
