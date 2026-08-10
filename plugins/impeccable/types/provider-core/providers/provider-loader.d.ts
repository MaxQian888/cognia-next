import { ProviderConfig } from "@cognia/provider-types/provider"

/**
 * Dynamic provider registry.
 *
 * Plugins can register an AI provider definition at runtime; the
 * settings UI and the projection layer subscribe to this registry to
 * surface plugin-contributed providers in the picker. Disabling the
 * plugin removes its providers via `unregisterProvider`.
 *
 * The registry is purely in-memory — provider definitions disappear on
 * reload. Plugins that want their providers to persist must call
 * register on every activation.
 */

type ProviderType = "cloud" | "local" | "self-hosted"
type ProviderProtocol = "openai" | "anthropic" | "google" | "mistral" | "cohere"
interface ProviderModelDefinition {
  id: string
  name: string
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsStreaming: boolean
}
interface ProviderDefinition {
  id: string
  name: string
  type: ProviderType
  protocol: ProviderProtocol
  apiKeyRequired: boolean
  baseURLRequired: boolean
  defaultModel: string
  defaultEnabled: boolean
  category: "core" | "specialized" | "experimental"
  description?: string
  models: ProviderModelDefinition[]
}
type ProviderSource = "builtin" | "plugin"
declare function registerProviderDefinition(
  definition: ProviderDefinition,
  source?: ProviderSource
): {
  replaced: boolean
}
declare function unregisterProvider(providerId: string): boolean
declare function unregisterProvidersBySource(source: ProviderSource): number
declare function getProviderDefinition(providerId: string): ProviderDefinition | undefined
declare function listProviderDefinitions(filter?: { source?: ProviderSource }): ProviderDefinition[]
/** Test-only escape hatch. */
declare function __resetProviderRegistryForTesting(): void
/**
 * Returns plugin-registered providers in the ProviderConfig shape so they
 * can be merged into getAllProviders(). Adapts ProviderDefinition →
 * ProviderConfig: maps protocol/category/type to the narrower canonical
 * unions used throughout the rest of the codebase.
 */
declare function getDynamicProviders(): Record<string, ProviderConfig>

export {
  type ProviderDefinition,
  type ProviderModelDefinition,
  type ProviderProtocol,
  type ProviderSource,
  type ProviderType,
  __resetProviderRegistryForTesting,
  getDynamicProviders,
  getProviderDefinition,
  listProviderDefinitions,
  registerProviderDefinition,
  unregisterProvider,
  unregisterProvidersBySource,
}
