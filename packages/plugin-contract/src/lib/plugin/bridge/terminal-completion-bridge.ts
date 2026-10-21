/**
 * The plugin contract's share of `lib/plugin/bridge/terminal-completion-bridge.ts`, which re-exports these.
 */

export interface TerminalCompletionBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface TerminalCompletionBridgeResult {
  registered: number
  errors: TerminalCompletionBridgeError[]
}

export interface TerminalCompletionBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
}
