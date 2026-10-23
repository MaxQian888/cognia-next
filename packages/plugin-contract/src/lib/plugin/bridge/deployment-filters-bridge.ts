/**
 * The plugin contract's share of `lib/plugin/bridge/deployment-filters-bridge.ts`, which re-exports these.
 */

export interface DeploymentFiltersBridgeError {
  pluginId: string
  filterId: string
  message: string
}

export interface DeploymentFiltersBridgeResult {
  registered: number
  errors: DeploymentFiltersBridgeError[]
}

export interface DeploymentFiltersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}
