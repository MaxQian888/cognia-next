import { ModelConfig, ProviderModelDiscoveryEntry, LocalProviderName } from "@cognia/provider-types"

type ProviderModelSource = "catalog-static" | "models-dev" | "remote-discovered" | "user-curated"
type ProviderModelFreshness = "static" | "fresh" | "stale"
type ProviderModelCandidate = ProviderModelDiscoveryEntry
interface DiscoveredProviderModel extends ModelConfig {
  source: ProviderModelSource
  freshness: ProviderModelFreshness
  mergedSources: ProviderModelSource[]
  provider?: string
}
interface ProviderModelDiscoverySnapshot {
  providerId: string
  models: DiscoveredProviderModel[]
  remoteLastFetchedAt?: number
}
interface DiscoveredModelStateLike {
  discoveredModels?: ProviderModelCandidate[]
  discoveredModelsLastFetched?: number
}
interface CustomProviderModelStateLike extends DiscoveredModelStateLike {
  customModels?: string[]
  customModelMetadata?: Record<
    string,
    {
      id?: string
      name?: string
      contextLength?: number
      maxOutputTokens?: number
      pricing?: {
        promptPer1M?: number
        completionPer1M?: number
      }
      capabilities?: {
        vision?: boolean
        functionCalling?: boolean
        streaming?: boolean
      }
    }
  >
}
declare function modelConfigToProviderModelCandidate(
  model: Partial<ModelConfig> & {
    id: string
    name?: string
    provider?: string
  }
): ProviderModelCandidate
/**
 * Field-level merge of two pricing records under the layered-authority rule.
 * Exported so settings views (comparison/cost) enrich catalog pricing with
 * models.dev through the SAME precedence + full field set instead of
 * hand-rolling a partial copy that silently drops cache/batch/audio fields.
 */
declare function mergePricing(
  existing: ModelConfig["pricing"],
  incoming: ModelConfig["pricing"],
  overwrite: boolean
): ModelConfig["pricing"]
declare function buildProviderModelDiscoverySnapshot(input: {
  providerId: string
  catalogModels?: ProviderModelCandidate[]
  modelsDevModels?: ProviderModelCandidate[]
  remoteModels?: ProviderModelCandidate[]
  remoteLastFetchedAt?: number
  userCuratedModels?: ProviderModelCandidate[]
}): ProviderModelDiscoverySnapshot
declare function buildBuiltInProviderModelDiscoverySnapshot(input: {
  providerId: string
  catalogModels?: ProviderModelCandidate[]
  modelsDevModels?: ProviderModelCandidate[]
  settings?: DiscoveredModelStateLike
}): ProviderModelDiscoverySnapshot
declare function buildCustomProviderModelDiscoverySnapshot(input: {
  providerId: string
  provider?: CustomProviderModelStateLike
}): ProviderModelDiscoverySnapshot
declare function discoverOpenRouterModels(apiKey?: string): Promise<ProviderModelCandidate[]>
declare function discoverCLIProxyAPIModels(input: {
  apiKey: string
  host?: string
  port?: number
}): Promise<ProviderModelCandidate[]>
declare function discoverLocalProviderModels(
  providerId: LocalProviderName,
  baseURL?: string
): Promise<ProviderModelCandidate[]>
declare function discoverOpenAICompatibleModels(input: {
  baseURL: string
  apiKey?: string
}): Promise<ProviderModelCandidate[]>

export {
  type DiscoveredProviderModel,
  type ProviderModelCandidate,
  type ProviderModelDiscoverySnapshot,
  type ProviderModelFreshness,
  type ProviderModelSource,
  buildBuiltInProviderModelDiscoverySnapshot,
  buildCustomProviderModelDiscoverySnapshot,
  buildProviderModelDiscoverySnapshot,
  discoverCLIProxyAPIModels,
  discoverLocalProviderModels,
  discoverOpenAICompatibleModels,
  discoverOpenRouterModels,
  mergePricing,
  modelConfigToProviderModelCandidate,
}
