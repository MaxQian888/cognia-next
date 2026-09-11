import { fetchModels as fetchCLIProxyAPIModels } from "./cliproxyapi"
import { createLocalProviderService } from "./local-provider-service"
import { listModels as listOpenRouterModels, parseModelPricing } from "./openrouter"
import type { LocalProviderName, ModelConfig, ModelPricing } from "@cognia/provider-types"
import { proxyFetch } from "./runtime-adapters"

// The three pure vocabulary types moved to `@cognia/provider-types`
// (`model-discovery-types.ts`) so the operation contract can name them.
// Re-exported here so every existing call site keeps its import path.
export type {
  ProviderModelCandidate,
  ProviderModelFreshness,
  ProviderModelSource,
} from "@cognia/provider-types"
import type {
  ProviderModelCandidate,
  ProviderModelFreshness,
  ProviderModelSource,
} from "@cognia/provider-types"

export interface DiscoveredProviderModel extends ModelConfig {
  source: ProviderModelSource
  freshness: ProviderModelFreshness
  mergedSources: ProviderModelSource[]
  provider?: string
  /** Fields supplied by a source before compatibility display defaults were applied. */
  knownFields?: string[]
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
    Partial<ProviderModelCandidate> & {
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
    maxInputTokens: candidate.maxInputTokens,
    maxOutputTokens: candidate.maxOutputTokens,
    supportsTools: candidate.supportsTools ?? true,
    supportsVision: candidate.supportsVision ?? false,
    supportsAudio: candidate.supportsAudio ?? false,
    supportsVideo: candidate.supportsVideo ?? false,
    supportsStreaming: candidate.supportsStreaming ?? true,
    supportsReasoning: candidate.supportsReasoning,
    supportsImageGeneration: candidate.supportsImageGeneration,
    supportsEmbedding: candidate.supportsEmbedding,
    supportsStructuredOutput: candidate.supportsStructuredOutput,
    pricing:
      candidate.pricing?.promptPer1M !== undefined &&
      candidate.pricing?.completionPer1M !== undefined
        ? {
            promptPer1M: candidate.pricing.promptPer1M,
            completionPer1M: candidate.pricing.completionPer1M,
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
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsStreaming: model.supportsStreaming,
    supportsReasoning: model.supportsReasoning,
    supportsImageGeneration: model.supportsImageGeneration,
    supportsEmbedding: model.supportsEmbedding,
    supportsStructuredOutput: model.supportsStructuredOutput,
    pricing:
      model.pricing?.promptPer1M !== undefined || model.pricing?.completionPer1M !== undefined
        ? { ...model.pricing }
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
      ...modelMetadata,
      id: modelId,
      supportsTools: modelMetadata?.supportsTools ?? modelMetadata?.capabilities?.functionCalling,
      supportsVision: modelMetadata?.supportsVision ?? modelMetadata?.capabilities?.vision,
      supportsStreaming: modelMetadata?.supportsStreaming ?? modelMetadata?.capabilities?.streaming,
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
  existing: ProviderModelCandidate,
  incoming: ProviderModelCandidate,
  overwrite: boolean
): ProviderModelCandidate {
  const out: ProviderModelCandidate = { ...existing }
  for (const key of Object.keys(incoming) as (keyof ProviderModelCandidate)[]) {
    if (key === "pricing" || key === "id") continue
    const inc = incoming[key]
    if (inc === undefined) continue
    if (overwrite || out[key] === undefined) {
      out[key] = inc as never
    }
  }
  if (incoming.pricing) {
    out.pricing = { ...existing.pricing }
    for (const key of PRICING_KEYS) {
      const value = incoming.pricing[key]
      if (value !== undefined && (overwrite || out.pricing[key] === undefined)) {
        out.pricing[key] = value as never
      }
    }
  }
  return out
}

export function buildProviderModelDiscoverySnapshot(input: {
  providerId: string
  catalogModels?: ProviderModelCandidate[]
  modelsDevModels?: ProviderModelCandidate[]
  remoteModels?: ProviderModelCandidate[]
  remoteLastFetchedAt?: number
  userCuratedModels?: ProviderModelCandidate[]
  /** Subscription APIs return account-specific limits and entitlements. */
  remoteOverridesCatalog?: boolean
}): ProviderModelDiscoverySnapshot {
  const merged = new Map<
    string,
    ProviderModelCandidate & {
      source: ProviderModelSource
      freshness: ProviderModelFreshness
      mergedSources: ProviderModelSource[]
    }
  >()

  const applyModels = (
    models: ProviderModelCandidate[] | undefined,
    source: ProviderModelSource,
    overwrite: boolean
  ) => {
    for (const model of models || []) {
      const existing = merged.get(model.id)
      if (!existing) {
        merged.set(model.id, {
          ...model,
          source,
          freshness: sourceFreshness(source, input.remoteLastFetchedAt),
          mergedSources: [source],
          provider: model.provider,
        })
        continue
      }

      merged.set(model.id, {
        ...mergeModelConfig(existing, model, overwrite),
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
  applyModels(input.remoteModels, "remote-discovered", input.remoteOverridesCatalog ?? false)
  applyModels(input.userCuratedModels, "user-curated", true)

  return {
    providerId: input.providerId,
    // Defaults belong at the output boundary: applying them before merging
    // turns unknown capabilities into false/true and blocks remote metadata.
    models: Array.from(merged.values(), (model) => ({
      ...candidateToModelConfig(model),
      source: model.source,
      freshness: model.freshness,
      mergedSources: model.mergedSources,
      provider: model.provider,
      knownFields: Object.entries(model)
        .filter(
          ([key, value]) =>
            value !== undefined && !["source", "freshness", "mergedSources"].includes(key)
        )
        .map(([key]) => key),
    })),
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
  signal?: AbortSignal
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
    ...(input.signal ? { signal: input.signal } : {}),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`)
  }

  return parseProviderModelsWire(await response.json())
}

function wireRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Read shared OpenAI/Anthropic model metadata without inventing capabilities. */
export function parseProviderModelWire(value: unknown): ProviderModelCandidate {
  if (!wireRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("Provider returned an invalid model identifier")
  }
  const model: ProviderModelCandidate = { id: value.id }
  const text = (key: string): string | undefined => {
    const field = value[key]
    if (field === undefined || field === null) return undefined
    if (typeof field !== "string") throw new Error(`Provider returned invalid model ${key}`)
    return field || undefined
  }
  const number = (key: string): number | undefined => {
    const field = value[key]
    if (field === undefined || field === null) return undefined
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new Error(`Provider returned invalid model ${key}`)
    }
    return field
  }
  model.name = text("display_name") ?? text("name")
  model.provider = text("owned_by")
  model.maxInputTokens =
    number("max_input_tokens") ?? number("input_token_limit") ?? number("inputTokenLimit")
  model.contextLength = number("context_length") ?? model.maxInputTokens
  model.maxOutputTokens =
    number("max_output_tokens") ??
    number("output_token_limit") ??
    number("outputTokenLimit") ??
    number("max_tokens")
  const capabilityFields = {
    supportsTools: ["supports_tools", "tool_use"],
    supportsVision: ["supports_vision", "image_input", "supports_image_in"],
    supportsAudio: ["supports_audio", "audio_input"],
    supportsVideo: ["supports_video", "video_input", "supports_video_in"],
    supportsStreaming: ["supports_streaming", "streaming"],
    supportsReasoning: ["supports_reasoning", "thinking"],
    supportsImageGeneration: ["supports_image_generation", "image_generation"],
    supportsEmbedding: ["supports_embedding", "embedding"],
    supportsStructuredOutput: ["supports_structured_output", "structured_outputs"],
  } as const
  for (const [key, [field, capability, alias]] of Object.entries(capabilityFields)) {
    const nested = wireRecord(value.capabilities) ? value.capabilities[capability] : undefined
    const flag =
      value[field] ??
      (alias ? value[alias] : undefined) ??
      (wireRecord(nested) ? nested.supported : undefined)
    if (flag === undefined || flag === null) continue
    if (typeof flag !== "boolean") throw new Error(`Provider returned invalid model ${field}`)
    model[key as keyof typeof capabilityFields] = flag
  }
  return model
}

export function parseProviderModelsWire(value: unknown): ProviderModelCandidate[] {
  if (!wireRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Provider returned an invalid models list")
  }
  return value.data.map(parseProviderModelWire)
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
