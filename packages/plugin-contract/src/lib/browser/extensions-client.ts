/**
 * The plugin contract's share of `lib/browser/extensions-client.ts`, which re-exports these.
 */
export type BrowserExtensionSource = "webstore" | "crx" | "unpacked"

export interface BrowserExtension {
  id: string
  name: string
  version: string
  enabled: boolean
  source: BrowserExtensionSource
  /** Epoch ms. */
  installedAt: number
  permissions: string[]
  hostPermissions: string[]
  iconPath: string | null
  popupPath: string | null
  optionsPath: string | null
  description: string | null
  /** Newer version seen by the last update check, when any. */
  updateAvailable?: string | null
}
