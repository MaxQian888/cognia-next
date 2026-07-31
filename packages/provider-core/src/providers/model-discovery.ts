import { fetchModels as fetchCLIProxyAPIModels } from "./cliproxyapi"
import { createLocalProviderService } from "./local-provider-service"
import { listModels as listOpenRouterModels, parseModelPricing } from "./openrouter"
import type {
  LocalProviderName,
  ModelConfig,
  ModelPricing,
  ProviderModelDiscoveryEntry,
} from "@cognia/provider-types"
import { proxyFetch } from "./runtime-adapters"

export type ProviderModelSource =
  "catalog-static" | "models-dev" | "remote-discovered" | "user-curated"
export type ProviderModelFreshness = "static" | "fresh" | "stale"

export type ProviderModelCandidate = ProviderModelDiscoveryEntry

export interface DiscoveredProviderModel extends ModelConfig {
  source: ProviderModelSource
  freshness: ProviderModelFreshness
  mergedSources: ProviderModelSource[]
  provider?: string
}

export interface ProviderModelDiscoverySnapshot {
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

function candidateToModelConfig(candidate: ProviderModelCandidate): ModelConfig {
  return {
    id: candidate.id,
    name: candidate.name || candidate.id,
    contextLength: candidate.contextLength ?? 0,
    maxOutputTokens: candidate.maxOutputTokens,
    supportsTools: candidate.supportsTools ?? true,
    supportsVision: candidate.supportsVision ?? false,
    supportsAudio: candidate.supportsAudio ?? false,
    supportsVideo: candidate.supportsVideo ?? false,
    supportsStreaming: candidate.supportsStreaming ?? true,
    supportsReasoning: candidate.supportsReasoning,
    supportsImageGeneration: candidate.supportsImageGeneration,
    supportsEmbedding: candidate.supportsEmbedding,
    pricing:
      candidate.pricing?.promptPer1M !== undefined ||
      candidate.pricing?.completionPer1M !== undefined
        ? {
            promptPer1M: candidate.pricing?.promptPer1M ?? 0,
            completionPer1M: candidate.pricing?.completionPer1M ?? 0,
            cachedInputPer1M: candidate.pricing?.cachedInputPer1M,
            cacheCreationPer1M: candidate.pricing?.cacheCreationPer1M,
            batchInputPer1M: candidate.pricing?.batchInputPer1M,
            batchOutputPer1M: candidate.pricing?.batchOutputPer1M,
            audioInputPer1M: candidate.pricing?.audioInputPer1M,
            audioOutputPer1M: candidate.pricing?.audioOutputPer1M,
            currency: candidate.pricing?.currency,
          }
        : undefined,
  }
}

export function modelConfigToProviderModelCandidate(
  model: Partial<ModelConfig> & { id: string; name?: string; provider?: string }
): ProviderModelCandidate {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsStreaming: model.supportsStreaming,
    supportsReasoning: model.supportsReasoning,
    supportsImageGeneration: model.supportsImageGeneration,
    supportsEmbedding: model.supportsEmbedding,
    pricing:
      model.pricing?.promptPer1M !== undefined || model.pricing?.completionPer1M !== undefined
        ? {
            promptPer1M: model.pricing?.promptPer1M,
            completionPer1M: model.pricing?.completionPer1M,
          }
        : undefined,
  }
}

function mergeSources(
  current: ProviderModelSource[],
  next: ProviderModelSource
): ProviderModelSource[] {
  return current.includes(next) ? current : [...current, next]
}

function sourceFreshness(
  source: ProviderModelSource,
  remoteLastFetchedAt?: number
): ProviderModelFreshness {
  if (source === "remote-discovered") {
    return remoteLastFetchedAt ? "fresh" : "stale"
  }

  return "static"
}

function getRemoteDiscoveredModels(
  state?: DiscoveredModelStateLike
): ProviderModelCandidate[] | undefined {
  return state?.discoveredModels?.map((model) => ({ ...model }))
}

function getUserCuratedModels(
  provider?: CustomProviderModelStateLike
): ProviderModelCandidate[] | undefined {
  if (!provider) return undefined

  const metadata = provider.customModelMetadata || {}
  const sourceModelIds = provider.customModels?.length
    ? provider.customModels
    : Object.keys(metadata)

  if (sourceModelIds.length === 0) return undefined

  return sourceModelIds.map((modelId) => {
    const modelMetadata = metadata[modelId]
    return {
      id: modelId,
      name: modelMetadata?.name || modelId,
      contextLength: modelMetadata?.contextLength,
      maxOutputTokens: modelMetadata?.maxOutputTokens,
      supportsTools: modelMetadata?.capabilities?.functionCalling ?? true,
      supportsVision: modelMetadata?.capabilities?.vision ?? false,
      supportsAudio: false,
      supportsVideo: false,
      supportsStreaming: modelMetadata?.capabilities?.streaming ?? true,
      pricing: modelMetadata?.pricing,
    }
  })
}

const PRICING_KEYS = [
  "promptPer1M",
  "completionPer1M",
  "cachedInputPer1M",
  "cacheCreationPer1M",
  "batchInputPer1M",
  "batchOutputPer1M",
  "audioInputPer1M",
  "audioOutputPer1M",
  "currency",
] as const

/**
 * Field-level merge of two pricing records under the layered-authority rule.
 * Exported so settings views (comparison/cost) enrich catalog pricing with
 * models.dev through the SAME precedence + full field set instead of
 * hand-rolling a partial copy that silently drops cache/batch/audio fields.
 */
export function mergePricing(
  existing: ModelConfig["pricing"],
  incoming: ModelConfig["pricing"],
  overwrite: boolean
): ModelConfig["pricing"] {
  if (!existing) return incoming
  if (!incoming) return existing
  const out: ModelPricing = { ...existing }
  for (const key of PRICING_KEYS) {
    const inc = incoming[key]
    if (inc === undefined) continue
    if (overwrite || out[key] === undefined) {
      // Each key is assigned from the matching key, so the value type lines up.
      out[key] = inc as never
    }
  }
  return out
}

/**
 * Field-level merge realizing the layered-authority precedence. `overwrite`
 * sources (catalog-static base, models-dev, user-curated) replace defined
 * fields; fill-missing sources (remote-discovered) only populate gaps — so a
 * bare `/v1/models` entry can add a new model id without clobbering the pricing
 * or capabilities models.dev already supplied.
 */
function mergeModelConfig(
  existing: ModelConfig,
  incoming: ModelConfig,
  overwrite: boolean
): ModelConfig {
  const out: ModelConfig = { ...existing }
  for (const key of Object.keys(incoming) as (keyof ModelConfig)[]) {
    if (key === "pricing" || key === "id") continue
    const inc = incoming[key]
    if (inc === undefined) continue
    if (overwrite || out[key] === undefined) {
      out[key] = inc as never
    }
  }
  out.pricing = mergePricing(existing.pricing, incoming.pricing, overwrite)
  return out
}

export function buildProviderModelDiscoverySnapshot(input: {
  providerId: string
  catalogModels?: ProviderModelCandidate[]
  modelsDevModels?: ProviderModelCandidate[]
  remoteModels?: ProviderModelCandidate[]
  remoteLastFetchedAt?: number
  userCuratedModels?: ProviderModelCandidate[]
}): ProviderModelDiscoverySnapshot {
  const merged = new Map<string, DiscoveredProviderModel>()

  const applyModels = (
    models: ProviderModelCandidate[] | undefined,
    source: ProviderModelSource,
    overwrite: boolean
  ) => {
    for (const model of models || []) {
      const normalized = candidateToModelConfig(model)
      const existing = merged.get(model.id)
      if (!existing) {
        merged.set(model.id, {
          ...normalized,
          source,
          freshness: sourceFreshness(source, input.remoteLastFetchedAt),
          mergedSources: [source],
          provider: model.provider,
        })
        continue
      }

      merged.set(model.id, {
        ...mergeModelConfig(existing, normalized, overwrite),
        // A fill-only pass (overwrite=false, i.e. live /v1/models) may add data
        // to a higher-authority model but must not relabel its provenance —
        // otherwise a models.dev-authoritative model that also appears in the
        // live list gets stamped "remote-discovered" and can flip to a "stale"
        // badge. `mergedSources` still records every contributing source.
        source: overwrite ? source : existing.source,
        freshness: overwrite
          ? sourceFreshness(source, input.remoteLastFetchedAt)
          : existing.freshness,
        mergedSources: mergeSources(existing.mergedSources, source),
        provider: (overwrite ? model.provider : existing.provider) ?? existing.provider,
      })
    }
  }

  // Layered authority: static is the base; models.dev wins model-level fields;
  // live /v1/models only fills gaps + adds new ids; user-curated is explicit.
  applyModels(input.catalogModels, "catalog-static", true)
  applyModels(input.modelsDevModels, "models-dev", true)
  applyModels(input.remoteModels, "remote-discovered", false)
  applyModels(input.userCuratedModels, "user-curated", true)

  return {
    providerId: input.providerId,
    models: Array.from(merged.values()),
    remoteLastFetchedAt: input.remoteLastFetchedAt,
  }
}

export function buildBuiltInProviderModelDiscoverySnapshot(input: {
  providerId: string
  catalogModels?: ProviderModelCandidate[]
  modelsDevModels?: ProviderModelCandidate[]
  settings?: DiscoveredModelStateLike
}): ProviderModelDiscoverySnapshot {
  return buildProviderModelDiscoverySnapshot({
    providerId: input.providerId,
    catalogModels: input.catalogModels,
    modelsDevModels: input.modelsDevModels,
    remoteModels: getRemoteDiscoveredModels(input.settings),
    remoteLastFetchedAt: input.settings?.discoveredModelsLastFetched,
  })
}

export function buildCustomProviderModelDiscoverySnapshot(input: {
  providerId: string
  provider?: CustomProviderModelStateLike
}): ProviderModelDiscoverySnapshot {
  return buildProviderModelDiscoverySnapshot({
    providerId: input.providerId,
    remoteModels: getRemoteDiscoveredModels(input.provider),
    remoteLastFetchedAt: input.provider?.discoveredModelsLastFetched,
    userCuratedModels: getUserCuratedModels(input.provider),
  })
}

export async function discoverOpenRouterModels(apiKey?: string): Promise<ProviderModelCandidate[]> {
  const models = await listOpenRouterModels(apiKey)
  return models.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: model.id.split("/")[0],
    contextLength: model.context_length,
    maxOutputTokens:
      model.top_provider?.max_completion_tokens ?? model.per_request_limits?.completion_tokens,
    supportsTools: true,
    supportsVision: Boolean(model.architecture?.modality?.includes("image")),
    supportsAudio: Boolean(model.architecture?.modality?.includes("audio")),
    supportsVideo: Boolean(model.architecture?.modality?.includes("video")),
    supportsStreaming: true,
    pricing: parseModelPricing(model),
  }))
}

export async function discoverCLIProxyAPIModels(input: {
  apiKey: string
  host?: string
  port?: number
}): Promise<ProviderModelCandidate[]> {
  const models = await fetchCLIProxyAPIModels(input.apiKey, input.host, input.port)
  return models.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    contextLength: model.contextLength,
    supportsTools: true,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
  }))
}

export async function discoverLocalProviderModels(
  providerId: LocalProviderName,
  baseURL?: string
): Promise<ProviderModelCandidate[]> {
  const service = createLocalProviderService(providerId, baseURL)
  const models = await service.listModels()
  return models.map((model) => ({
    id: model.id,
    name: model.id,
    provider: model.owned_by,
    contextLength: model.context_length,
    supportsTools: true,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
  }))
}

export async function discoverOpenAICompatibleModels(input: {
  baseURL: string
  apiKey?: string
}): Promise<ProviderModelCandidate[]> {
  const trimmedBaseURL = input.baseURL.trim().replace(/\/+$/, "")
  const modelsURL = buildOpenAICompatibleModelsURL(trimmedBaseURL)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (input.apiKey) {
    headers.Authorization = `Bearer ${input.apiKey}`
  }

  const response = await proxyFetch(modelsURL, {
    method: "GET",
    headers,
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`)
  }

  const payload = (await response.json()) as {
    data?: Array<{
      id: string
      owned_by?: string
      context_length?: number
    }>
  }

  return (payload.data || []).map((model) => ({
    id: model.id,
    name: model.id,
    provider: model.owned_by,
    contextLength: model.context_length,
    supportsTools: true,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
  }))
}

function buildOpenAICompatibleModelsURL(trimmedBaseURL: string): string {
  if (isZhipuPaasV4BaseURL(trimmedBaseURL)) {
    return `${trimmedBaseURL}/models`
  }

  return trimmedBaseURL.endsWith("/v1") ? `${trimmedBaseURL}/models` : `${trimmedBaseURL}/v1/models`
}

function isZhipuPaasV4BaseURL(trimmedBaseURL: string): boolean {
  return /^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4$/i.test(trimmedBaseURL)
}
