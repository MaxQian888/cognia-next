/**
 * The plugin contract's share of `lib/plugin/bridge/workspace-backend-bridge.ts`, which re-exports these.
 */

export interface WorkspaceBackendBridgeError {
  pluginId: string
  backendId: string
  message: string
}

export interface WorkspaceBackendBridgeResult {
  registered: number
  errors: WorkspaceBackendBridgeError[]
}

export interface WorkspaceBackendBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
  getSecret?: (pluginId: string, key: string) => Promise<string | undefined>
}
