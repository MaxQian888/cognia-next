/**
 * The plugin contract's share of `lib/plugin/bridge/routing-strategies-bridge.ts`, which re-exports these.
 */

export interface RoutingStrategiesBridgeError {
  pluginId: string
  strategyId: string
  message: string
}

export interface RoutingStrategiesBridgeResult {
  registered: number
  errors: RoutingStrategiesBridgeError[]
}

export interface RoutingStrategiesBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}
