/**
 * The plugin contract's share of `lib/plugin/bridge/ai-providers-bridge.ts`, which re-exports these.
 */

import type { CatalogRepository } from "@cognia/provider-core/providers/catalog-repository"

export interface AiProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface AiProvidersBridgeResult {
  registered: number
  errors: AiProvidersBridgeError[]
}

export interface AiProvidersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  getConfig?: (pluginId: string, key: string) => unknown
  getSecret?: (pluginId: string, key: string) => Promise<string | undefined>
  catalogRepository?: CatalogRepository
}
