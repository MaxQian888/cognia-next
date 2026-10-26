/**
 * The plugin contract's share of `lib/plugin/bridge/protocol-adapters-bridge.ts`, which re-exports these.
 */

export interface ProtocolAdaptersBridgeError {
  pluginId: string
  adapterId: string
  message: string
}

export interface ProtocolAdaptersBridgeResult {
  registered: number
  errors: ProtocolAdaptersBridgeError[]
}

export interface ProtocolAdaptersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}
