/**
 * The plugin contract's share of `lib/plugin/bridge/context-providers-bridge.ts`, which re-exports these.
 */
export interface ContextProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface ContextProvidersBridgeResult {
  registered: number
  errors: ContextProvidersBridgeError[]
}

export interface ContextProvidersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}
