/**
 * The plugin contract's share of `lib/plugin/bridge/themes-bridge.ts`, which re-exports these.
 */

export interface ThemesBridgeError {
  pluginId: string
  contributionId: string
  message: string
}

export interface ThemesBridgeRegisterResult {
  registered: number
  errors: ThemesBridgeError[]
}
