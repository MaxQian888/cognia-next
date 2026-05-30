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

import { proxyFetch } from "@/lib/network/proxy-fetch"
import type { BuiltInProviderAdapterId } from "@/types/provider/built-in-provider-catalog"
import type { ModelPricing, ProviderModelDiscoveryEntry } from "@/types/provider/provider"
import {
  builtInProvidersWithModelsDevEntry,
  resolveModelsDevProviderId,
} from "@/lib/ai/providers/models-dev-id-map"

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
  for (const ourId of builtInProvidersWithModelsDevEntry()) {
    const devId = resolveModelsDevProviderId(ourId)
    if (!devId) continue
    const provider = api[devId]
    if (!provider || typeof provider !== "object" || !provider.models) continue
    out[ourId] = {
      modelsDevId: devId,
      name: provider.name || devId,
      doc: provider.doc,
      npm: provider.npm,
      api: provider.api,
      models: Object.values(provider.models).map((m) => mapModelsDevModel(provider, m)),
    }
  }
  return out
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
