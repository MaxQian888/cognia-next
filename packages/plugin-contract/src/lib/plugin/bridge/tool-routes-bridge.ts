/**
 * The plugin contract's share of `lib/plugin/bridge/tool-routes-bridge.ts`, which re-exports these.
 */

export interface ToolRoutesBridgeResult {
  registered: number
  errors: Array<{ pluginId: string; toolName: string; message: string }>
}
