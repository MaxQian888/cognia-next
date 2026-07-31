/**
 * models.dev catalog: fetch + mapping layer.
 *
 * models.dev (https://models.dev/api.json) is an open, always-fresh database of
 * AI providers and their models (context windows, pricing, capabilities, release
 * dates). It is the catalog backbone of opencode (which this repo integrates as
 * an external agent backend) and the source of our provider *icons*.
 *
 * This module is the single source of truth for translating a raw models.dev
 * record into our internal model shape. Per the layered-authority design,
 * models.dev owns *model-level* data (lists, capabilities, pricing, context,
 * variants/modes, family/dates); the static catalog
 * (`types/provider/built-in-provider-catalog.ts`) keeps *provider-level* wiring
 * (baseURL, OAuth, adapter defaults, quick-add).
 *
 * Mirrors opencode's `fromModelsDevModel` + `ProviderTransform.variants`
 * (`lib/ai/agent/external/opencode-client.ts` is the external-backend client),
 * adapted to our `ProviderModelDiscoveryEntry`.
 */

import type {
  BuiltInProviderAdapterId,
  BuiltInProviderCatalogEntry,
  BuiltInProviderModelEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import type {
  AdapterFamily,
  CatalogModality,
  CatalogSnapshot,
  CatalogSource,
  ModelDataModality,
  ModelDefinition,
  ModelLifecycle,
  ProviderDefinition,
  ProviderOffering,
} from "@cognia/provider-types/model-catalog"
import { CATALOG_SCHEMA_VERSION } from "@cognia/provider-types/model-catalog"
import type { ModelPricing, ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import { builtInProvidersWithModelsDevEntry, resolveModelsDevProviderId } from "./models-dev-id-map"
import { proxyFetch } from "./runtime-adapters"

export const MODELS_DEV_API_URL = "https://models.dev/api.json"

// =============================================================================
// Raw models.dev shapes (validated against the bundled snapshot)
// =============================================================================

export interface ModelsDevModalities {
  input?: string[]
  output?: string[]
}

export interface ModelsDevCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

export interface ModelsDevLimit {
  context?: number
  output?: number
  input?: number
}

/** Per-model driver override (opencode reads `model.provider?.npm ?? provider.npm`). */
export interface ModelsDevProviderOverride {
  npm?: string
  api?: string
}

export interface ModelsDevExperimentalMode {
  cost?: ModelsDevCost
  provider?: {
    body?: Record<string, unknown>
    headers?: Record<string, string>
  }
}

export interface ModelsDevModel {
  id: string
  name?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  structured_output?: boolean
  knowledge?: string
  release_date?: string
  last_updated?: string
  modalities?: ModelsDevModalities
  open_weights?: boolean
  status?: string
  limit?: ModelsDevLimit
  cost?: ModelsDevCost
  provider?: ModelsDevProviderOverride
  interleaved?: { field?: string }
  experimental?: { modes?: Record<string, ModelsDevExperimentalMode> }
}

export interface ModelsDevProvider {
  id?: string
  name?: string
  doc?: string
  npm?: string
  api?: string
  env?: string[]
  models: Record<string, ModelsDevModel>
}

export type ModelsDevApi = Record<string, ModelsDevProvider>

// =============================================================================
// Our enriched catalog shapes
// =============================================================================

/** A reasoning "mode" expanded from models.dev `experimental.modes`. */
export interface ModelsDevMode {
  /** Synthetic id `${modelId}-${mode}` (opencode-style pseudo-model). */
  id: string
  mode: string
  pricing?: ModelPricing
  /** Provider body overrides (e.g. `{ speed: "fast" }`). */
  body?: Record<string, unknown>
  /** Provider header overrides (e.g. anthropic-beta). */
  headers?: Record<string, string>
}

/**
 * models.dev model mapped into our shape — a superset of
 * `ProviderModelDiscoveryEntry` carrying the extra display/routing metadata.
 */
export interface ModelsDevCatalogModel extends ProviderModelDiscoveryEntry {
  family?: string
  releaseDate?: string
  knowledge?: string
  lastUpdated?: string
  status?: string
  /** Driver/adapter hint derived from the model/provider npm package. */
  adapter?: BuiltInProviderAdapterId
  /** Resolved API endpoint template, if the model/provider declares one. */
  apiUrl?: string
  /** Reasoning effort tiers (display badges; future routing input). */
  variants?: string[]
  /** Expanded experimental modes. */
  modes?: ModelsDevMode[]
  /** Whether the model accepts file/document attachments (models.dev `attachment`). */
  supportsAttachment?: boolean
  /** Whether the weights are open (models.dev `open_weights`) — drives a badge. */
  openWeights?: boolean
  /** Whether the model honours a `temperature` sampling param (models.dev `temperature`). */
  supportsTemperature?: boolean
  /** Whether the model supports interleaved thinking (models.dev `interleaved`). */
  supportsInterleaved?: boolean
}

/** A provider's normalized models.dev entry, keyed by our internal provider id. */
export interface NormalizedModelsDevProvider {
  /** models.dev provider id this was sourced from. */
  modelsDevId: string
  name: string
  doc?: string
  npm?: string
  api?: string
  models: ModelsDevCatalogModel[]
}

export type NormalizedModelsDevCatalog = Record<string, NormalizedModelsDevProvider>

// =============================================================================
// Mapping helpers
// =============================================================================

/** Reasoning effort tiers surfaced for any reasoning-capable model. */
export const REASONING_VARIANT_TIERS = ["low", "medium", "high"] as const

/**
 * Map a driver npm package to one of our adapter ids. Default is
 * `openai-compatible` — the same long-tail fallback opencode uses, which lets
 * any OpenAI-Chat-dialect provider work without bespoke code.
 */
export function deriveAdapterFromNpm(npm?: string): BuiltInProviderAdapterId {
  if (!npm) return "openai-compatible"
  const pkg = npm.toLowerCase()
  if (pkg.includes("@ai-sdk/anthropic")) return "anthropic"
  if (pkg.includes("@ai-sdk/google")) return "gemini"
  if (pkg.includes("openrouter")) return "openrouter"
  return "openai-compatible"
}

function mapCost(cost: ModelsDevCost | undefined): ModelPricing | undefined {
  if (!cost) return undefined
  // `promptPer1M`/`completionPer1M` are the per-token rates every downstream
  // cost calculator multiplies by, and `ModelPricing` requires them. An entry
  // that declares ONLY cache pricing has no usable per-token rate — coercing
  // the missing input/output to 0 would make cost views render "$0.00" instead
  // of "unknown". So a pricing object is only emitted when at least one
  // per-token rate is present; cache-only entries map to no pricing.
  if (cost.input === undefined && cost.output === undefined) return undefined
  return {
    promptPer1M: cost.input ?? 0,
    completionPer1M: cost.output ?? 0,
    cachedInputPer1M: cost.cache_read,
    cacheCreationPer1M: cost.cache_write,
  }
}

/** Reasoning tiers for a model — empty unless the model is reasoning-capable. */
export function computeModelVariants(model: ModelsDevModel): string[] {
  if (!model.reasoning) return []
  return [...REASONING_VARIANT_TIERS]
}

function camelCase(key: string): string {
  return key.replace(/[_-]([a-z0-9])/gi, (_, c: string) => c.toUpperCase())
}

function camelizeBody(
  body: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!body) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) out[camelCase(k)] = v
  return out
}

/**
 * Expand `experimental.modes` into pseudo-model entries (opencode emits
 * `${model.id}-${mode}`). camelCases the provider body so it slots straight
 * into AI SDK options.
 */
export function expandModelModes(model: ModelsDevModel): ModelsDevMode[] {
  const modes = model.experimental?.modes
  if (!modes) return []
  return Object.entries(modes).map(([mode, def]) => ({
    id: `${model.id}-${mode}`,
    mode,
    pricing: mapCost(def.cost),
    body: camelizeBody(def.provider?.body),
    headers: def.provider?.headers,
  }))
}

function inputHas(model: ModelsDevModel, modality: string): boolean {
  return Boolean(model.modalities?.input?.includes(modality))
}

function outputHas(model: ModelsDevModel, modality: string): boolean {
  return Boolean(model.modalities?.output?.includes(modality))
}

/**
 * Translate a single models.dev model into our enriched shape. `provider` is
 * the owning models.dev provider (for npm/api inheritance).
 */
export function mapModelsDevModel(
  provider: ModelsDevProvider,
  model: ModelsDevModel
): ModelsDevCatalogModel {
  const npm = model.provider?.npm ?? provider.npm
  const apiUrl = model.provider?.api ?? provider.api
  const variants = computeModelVariants(model)
  const modes = expandModelModes(model)
  const isEmbedding =
    /embed/i.test(model.id) || /embed/i.test(model.family ?? "") || outputHas(model, "embedding")

  return {
    id: model.id,
    name: model.name || model.id,
    contextLength: model.limit?.context,
    maxOutputTokens: model.limit?.output,
    supportsTools: model.tool_call ?? false,
    supportsVision: inputHas(model, "image"),
    supportsAudio: inputHas(model, "audio"),
    supportsVideo: inputHas(model, "video"),
    supportsStreaming: true,
    supportsReasoning: model.reasoning ?? undefined,
    supportsImageGeneration: outputHas(model, "image") || undefined,
    supportsEmbedding: isEmbedding || undefined,
    supportsStructuredOutput: model.structured_output ?? undefined,
    pricing: mapCost(model.cost),
    family: model.family,
    releaseDate: model.release_date,
    knowledge: model.knowledge,
    lastUpdated: model.last_updated,
    status: model.status,
    adapter: deriveAdapterFromNpm(npm),
    apiUrl,
    variants: variants.length > 0 ? variants : undefined,
    modes: modes.length > 0 ? modes : undefined,
    supportsAttachment: model.attachment ?? undefined,
    openWeights: model.open_weights ?? undefined,
    supportsTemperature: model.temperature ?? undefined,
    supportsInterleaved: model.interleaved ? true : undefined,
  }
}

/**
 * Normalize the full models.dev payload into a catalog keyed by *our* provider
 * ids, restricted to built-ins that have a models.dev entry. The 100+ models.dev
 * providers with no configuration path in the app (and our local/untracked
 * providers) are dropped — this also resolves id differences (zhipu→zhipuai).
 */
export function normalizeModelsDevApi(api: ModelsDevApi): NormalizedModelsDevCatalog {
  const out: NormalizedModelsDevCatalog = {}
  const consumedModelsDevIds = new Set<string>()
  for (const ourId of builtInProvidersWithModelsDevEntry()) {
    const devId = resolveModelsDevProviderId(ourId)
    if (!devId) continue
    const provider = api[devId]
    if (!provider || typeof provider !== "object" || !provider.models) continue
    consumedModelsDevIds.add(devId)
    out[ourId] = {
      modelsDevId: devId,
      name: provider.name || devId,
      doc: provider.doc,
      npm: provider.npm,
      api: provider.api,
      models: Object.values(provider.models).map((m) => mapModelsDevModel(provider, m)),
    }
  }
  for (const [modelsDevId, provider] of Object.entries(api)) {
    if (
      consumedModelsDevIds.has(modelsDevId) ||
      !provider ||
      typeof provider !== "object" ||
      !provider.models
    ) {
      continue
    }
    out[`models-dev:${modelsDevId}`] = {
      modelsDevId,
      name: provider.name || modelsDevId,
      doc: provider.doc,
      npm: provider.npm,
      api: provider.api,
      models: Object.values(provider.models).map((model) => mapModelsDevModel(provider, model)),
    }
  }
  return out
}

// =============================================================================
// Unified catalog projection
// =============================================================================

export interface BuildCatalogSnapshotOptions {
  revisionId: string
  generatedAt: string
  checksum: string
  builtInCatalog: readonly BuiltInProviderCatalogEntry[]
  certifiedProviderIds: ReadonlySet<string>
  includeExperimentalProviders?: boolean
}

const MANUAL_SOURCE: CatalogSource = { kind: "manual", id: "built-in-provider-catalog" }
const MODELS_DEV_SOURCE: CatalogSource = {
  kind: "models-dev",
  id: MODELS_DEV_API_URL,
  url: MODELS_DEV_API_URL,
}
const BUNDLED_SOURCE: CatalogSource = { kind: "bundled", id: "built-in-model-fallback" }

function adapterFamily(adapter: BuiltInProviderAdapterId | undefined): AdapterFamily {
  switch (adapter) {
    case "anthropic":
      return "anthropic"
    case "gemini":
      return "gemini"
    case "openrouter":
      return "openrouter"
    case "bedrock":
      return "bedrock"
    case "local-openai-compatible":
      return "local-openai-compatible"
    default:
      return "openai-compatible"
  }
}

function canonicalModelId(providerRef: string, upstreamId: string): string {
  const slash = upstreamId.indexOf("/")
  if (slash > 0 && slash < upstreamId.length - 1) {
    return `${upstreamId.slice(0, slash)}:${upstreamId.slice(slash + 1)}`
  }
  return `${providerRef}:${upstreamId}`
}

function modelLifecycle(status: string | undefined): ModelLifecycle {
  switch (status?.toLocaleLowerCase()) {
    case "retired":
      return "retired"
    case "deprecated":
      return "deprecated"
    case "preview":
    case "beta":
    case "alpha":
      return "preview"
    default:
      return "active"
  }
}

function dataModalities(
  raw: readonly string[] | undefined,
  fallback: readonly ModelDataModality[]
): ModelDataModality[] {
  const allowed = new Set<ModelDataModality>(["text", "image", "audio", "video"])
  const mapped = (raw ?? []).filter((value): value is ModelDataModality =>
    allowed.has(value as ModelDataModality)
  )
  return mapped.length > 0 ? [...new Set(mapped)] : [...fallback]
}

function catalogModalities(
  supportsChat: boolean,
  models: readonly {
    supportsEmbedding?: boolean
    supportsImageGeneration?: boolean
    supportsAudio?: boolean
    id: string
  }[]
): CatalogModality[] {
  const modalities = new Set<CatalogModality>()
  if (supportsChat) modalities.add("language")
  if (models.some((model) => model.supportsEmbedding)) modalities.add("embedding")
  if (models.some((model) => /rerank/i.test(model.id))) modalities.add("rerank")
  if (models.some((model) => model.supportsImageGeneration)) modalities.add("image")
  if (models.some((model) => model.supportsAudio)) modalities.add("speech")
  if (modalities.size === 0) modalities.add("language")
  return [...modalities]
}

function endpointType(
  protocol: BuiltInProviderCatalogEntry["protocol"] | undefined,
  model: ModelsDevCatalogModel
): ProviderOffering["endpointType"] {
  if (model.supportsEmbedding) return "embedding"
  if (/rerank/i.test(model.id)) return "rerank"
  if (model.supportsImageGeneration) return "images"
  if (model.supportsAudio && !model.supportsVision && !model.supportsTools) return "speech"
  if (protocol === "anthropic") return "messages"
  if (protocol === "gemini") return "generate-content"
  if (protocol === "bedrock") return "bedrock-runtime"
  return "chat-completions"
}

function offeringPricing(
  pricing: ModelsDevCatalogModel["pricing"] | BuiltInProviderModelEntry["pricing"]
): ProviderOffering["pricing"] {
  if (!pricing) return undefined
  return {
    currency: pricing.currency ?? "USD",
    inputPer1M: pricing.promptPer1M,
    outputPer1M: pricing.completionPer1M,
    cachedInputPer1M: pricing.cachedInputPer1M,
    cacheWritePer1M: pricing.cacheCreationPer1M,
  }
}

function catalogModel(
  providerRef: string,
  mapped: ModelsDevCatalogModel,
  fallback: BuiltInProviderModelEntry | undefined
): ModelDefinition {
  const canonicalId = canonicalModelId(providerRef, mapped.id)
  const creator = canonicalId.slice(0, canonicalId.indexOf(":"))
  const manual = Boolean(fallback)
  const source = manual ? MANUAL_SOURCE : MODELS_DEV_SOURCE
  const inputFallback: ModelDataModality[] = [
    "text",
    ...(fallback?.supportsVision || mapped.supportsVision ? (["image"] as const) : []),
    ...(fallback?.supportsAudio || mapped.supportsAudio ? (["audio"] as const) : []),
    ...(fallback?.supportsVideo || mapped.supportsVideo ? (["video"] as const) : []),
  ]
  const outputFallback: ModelDataModality[] = fallback?.supportsImageGeneration
    ? ["image"]
    : ["text"]
  const contextLimit =
    (fallback?.contextLength ?? 0) > 0
      ? fallback?.contextLength
      : (mapped.contextLength ?? 0) > 0
        ? mapped.contextLength
        : undefined
  const outputLimit =
    (fallback?.maxOutputTokens ?? 0) > 0
      ? fallback?.maxOutputTokens
      : (mapped.maxOutputTokens ?? 0) > 0
        ? mapped.maxOutputTokens
        : undefined
  return {
    id: canonicalId,
    name: fallback?.name || mapped.name || mapped.id,
    creator,
    family: mapped.family,
    modalities: {
      input: dataModalities(undefined, inputFallback),
      output: dataModalities(
        mapped.supportsImageGeneration ? ["image"] : undefined,
        outputFallback
      ),
    },
    capabilities: {
      streaming: fallback?.supportsStreaming ?? mapped.supportsStreaming,
      tools: fallback?.supportsTools ?? mapped.supportsTools,
      structuredOutput: mapped.supportsStructuredOutput,
      reasoning: fallback?.supportsReasoning ?? mapped.supportsReasoning,
      attachments: mapped.supportsAttachment,
      temperature: mapped.supportsTemperature,
      openWeights: mapped.openWeights,
      embeddings: fallback?.supportsEmbedding ?? mapped.supportsEmbedding,
      rerank: /rerank/i.test(mapped.id) || undefined,
      imageGeneration: fallback?.supportsImageGeneration ?? mapped.supportsImageGeneration,
      speechGeneration:
        mapped.supportsAudio && !mapped.supportsVision && !mapped.supportsTools ? true : undefined,
    },
    limits:
      contextLimit || outputLimit
        ? {
            context: contextLimit,
            output: outputLimit,
          }
        : undefined,
    lifecycle: modelLifecycle(mapped.status),
    releasedAt: mapped.releaseDate,
    provenance: {
      name: source,
      capabilities: source,
      limits: manual ? MANUAL_SOURCE : MODELS_DEV_SOURCE,
      lifecycle: mapped.status ? MODELS_DEV_SOURCE : BUNDLED_SOURCE,
    },
  }
}

function fallbackMappedModel(model: BuiltInProviderModelEntry): ModelsDevCatalogModel {
  return {
    id: model.id,
    name: model.name,
    contextLength: model.contextLength || undefined,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsStreaming: model.supportsStreaming,
    supportsReasoning: model.supportsReasoning,
    supportsImageGeneration: model.supportsImageGeneration,
    supportsEmbedding: model.supportsEmbedding,
    pricing: model.pricing,
  }
}

function providerDefinition(
  id: string,
  name: string,
  entry: BuiltInProviderCatalogEntry | undefined,
  models: readonly ModelsDevCatalogModel[],
  options: BuildCatalogSnapshotOptions,
  source: CatalogSource
): ProviderDefinition {
  const brand = {
    ...(entry?.website?.startsWith("http") ? { website: entry.website } : {}),
    ...(entry?.docsUrl?.startsWith("http") ? { docsUrl: entry.docsUrl } : {}),
  }
  return {
    id,
    name,
    ...(Object.keys(brand).length > 0 ? { brand } : {}),
    tier: entry
      ? options.certifiedProviderIds.has(id)
        ? "certified"
        : "verified"
      : "experimental",
    source,
    modalities: catalogModalities(entry?.supportsChat !== false, models),
    adapterFamilies: [
      entry?.adapter
        ? adapterFamily(entry.adapter)
        : adapterFamily(models.find((model) => model.adapter)?.adapter),
    ],
    connectionSchema: {
      fields: [
        ...(entry?.baseURLRequired
          ? [{ id: "endpoint", kind: "endpoint" as const, required: true, advanced: true }]
          : []),
        ...(entry?.apiKeyRequired
          ? [{ id: "credential", kind: "credential-ref" as const, required: true }]
          : []),
      ],
    },
  }
}

/**
 * Project the existing static catalog and models.dev mapper into one revision.
 * Manual provider/model fields win; models.dev fills live metadata; static
 * rows remain the offline fallback.
 */
export function buildCatalogSnapshotFromModelsDev(
  api: ModelsDevApi,
  options: BuildCatalogSnapshotOptions
): CatalogSnapshot {
  const providers = new Map<string, ProviderDefinition>()
  const models = new Map<string, ModelDefinition>()
  const offerings = new Map<string, ProviderOffering>()
  const aliases = new Map<string, CatalogSnapshot["aliases"][number]>()
  const consumedModelsDevIds = new Set<string>()
  const builtInById = new Map(options.builtInCatalog.map((entry) => [entry.id, entry]))

  const addEntry = (
    entry: BuiltInProviderCatalogEntry,
    providerRef: string,
    upstream: ModelsDevProvider | undefined
  ) => {
    const mappedById = new Map(
      Object.values(upstream?.models ?? {}).map((model) => [
        model.id,
        mapModelsDevModel(upstream as ModelsDevProvider, model),
      ])
    )
    const staticById = new Map((entry.models ?? []).map((model) => [model.id, model]))
    const modelIds = new Set([
      ...mappedById.keys(),
      ...staticById.keys(),
      ...(entry.defaultModel ? [entry.defaultModel] : []),
    ])
    const providerModels: ModelsDevCatalogModel[] = []
    for (const modelId of modelIds) {
      const fallback = staticById.get(modelId)
      const mapped =
        mappedById.get(modelId) ??
        (fallback
          ? fallbackMappedModel(fallback)
          : ({
              id: modelId,
              name: modelId,
              supportsStreaming: true,
            } satisfies ModelsDevCatalogModel))
      providerModels.push(mapped)
      const definition = catalogModel(providerRef, mapped, fallback)
      if (!models.has(definition.id) || fallback) models.set(definition.id, definition)
      const lifecycle = definition.lifecycle
      const offeringId = `${entry.id}:${modelId}`
      offerings.set(offeringId, {
        id: offeringId,
        providerRef,
        deploymentRef: entry.id,
        modelRef: definition.id,
        upstreamId: modelId,
        endpointType: endpointType(entry.protocol, mapped),
        lifecycle,
        available: true,
        capabilities: definition.capabilities,
        limits: definition.limits,
        pricing: offeringPricing(fallback?.pricing ?? mapped.pricing),
        source: fallback ? MANUAL_SOURCE : upstream ? MODELS_DEV_SOURCE : BUNDLED_SOURCE,
      })
    }

    const providerEntry = builtInById.get(providerRef) ?? entry
    if (!providers.has(providerRef)) {
      providers.set(
        providerRef,
        providerDefinition(
          providerRef,
          providerEntry.name,
          providerEntry,
          providerModels,
          options,
          MANUAL_SOURCE
        )
      )
    }
    const defaultOfferingId = `${entry.id}:${entry.defaultModel}`
    if (offerings.has(defaultOfferingId)) {
      aliases.set(`role:${entry.id}:default`, {
        id: `role:${entry.id}:default`,
        kind: "role",
        target: { type: "offering", ref: defaultOfferingId },
      })
    }
  }

  for (const entry of options.builtInCatalog) {
    const modelsDevId = resolveModelsDevProviderId(entry.id)
    if (modelsDevId && api[modelsDevId]) consumedModelsDevIds.add(modelsDevId)
    addEntry(entry, entry.relayOf ?? entry.id, modelsDevId ? api[modelsDevId] : undefined)
  }

  for (const [modelsDevId, upstream] of Object.entries(api)) {
    if (consumedModelsDevIds.has(modelsDevId) || options.includeExperimentalProviders === false) {
      continue
    }
    const providerId = `models-dev:${modelsDevId}`
    const mappedModels = Object.values(upstream.models).map((model) =>
      mapModelsDevModel(upstream, model)
    )
    providers.set(
      providerId,
      providerDefinition(
        providerId,
        upstream.name || modelsDevId,
        undefined,
        mappedModels,
        options,
        MODELS_DEV_SOURCE
      )
    )
    for (const mapped of mappedModels) {
      const definition = catalogModel(modelsDevId, mapped, undefined)
      if (!models.has(definition.id)) models.set(definition.id, definition)
      offerings.set(`${providerId}:${mapped.id}`, {
        id: `${providerId}:${mapped.id}`,
        providerRef: providerId,
        deploymentRef: providerId,
        modelRef: definition.id,
        upstreamId: mapped.id,
        endpointType: endpointType(undefined, mapped),
        lifecycle: definition.lifecycle,
        available: true,
        capabilities: definition.capabilities,
        limits: definition.limits,
        pricing: offeringPricing(mapped.pricing),
        source: MODELS_DEV_SOURCE,
      })
    }
  }

  return {
    revision: {
      id: options.revisionId,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: options.generatedAt,
      sources: [MANUAL_SOURCE, MODELS_DEV_SOURCE, BUNDLED_SOURCE],
      checksum: options.checksum,
      integrity: "verified",
    },
    providers: [...providers.values()].sort((left, right) => left.id.localeCompare(right.id)),
    models: [...models.values()].sort((left, right) => left.id.localeCompare(right.id)),
    offerings: [...offerings.values()].sort((left, right) => left.id.localeCompare(right.id)),
    aliases: [...aliases.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

// =============================================================================
// Fetch
// =============================================================================

/** Fetch the live models.dev catalog. Throws on network / shape errors. */
export async function fetchModelsDevApi(): Promise<ModelsDevApi> {
  const res = await proxyFetch(MODELS_DEV_API_URL, {
    method: "GET",
    headers: { accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`models.dev returned HTTP ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as unknown
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("models.dev payload is not a provider map object")
  }
  return json as ModelsDevApi
}
