import {
  BuiltInProviderAdapterId,
  BuiltInProviderCatalogEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import { CatalogSnapshot } from "@cognia/provider-types/model-catalog"
import { ProviderModelDiscoveryEntry, ModelPricing } from "@cognia/provider-types/provider"

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

declare const MODELS_DEV_API_URL = "https://models.dev/api.json"
interface ModelsDevModalities {
  input?: string[]
  output?: string[]
}
interface ModelsDevCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}
interface ModelsDevLimit {
  context?: number
  output?: number
  input?: number
}
/** Per-model driver override (opencode reads `model.provider?.npm ?? provider.npm`). */
interface ModelsDevProviderOverride {
  npm?: string
  api?: string
}
interface ModelsDevExperimentalMode {
  cost?: ModelsDevCost
  provider?: {
    body?: Record<string, unknown>
    headers?: Record<string, string>
  }
}
interface ModelsDevModel {
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
  interleaved?: {
    field?: string
  }
  experimental?: {
    modes?: Record<string, ModelsDevExperimentalMode>
  }
}
interface ModelsDevProvider {
  id?: string
  name?: string
  doc?: string
  npm?: string
  api?: string
  env?: string[]
  models: Record<string, ModelsDevModel>
}
type ModelsDevApi = Record<string, ModelsDevProvider>
/** A reasoning "mode" expanded from models.dev `experimental.modes`. */
interface ModelsDevMode {
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
interface ModelsDevCatalogModel extends ProviderModelDiscoveryEntry {
  family?: string
  releaseDate?: string
  knowledge?: string
  lastUpdated?: string
  status?: string
  /** Driver/adapter hint derived from the model/provider npm package. */
  adapter?: BuiltInProviderAdapterId
  /** Resolved API endpoint template, if the model/provider declares one. */
  apiUrl?: string
  /**
   * Reasoning effort tiers this model actually offers, resolved from its
   * provider's wire surface by {@link computeModelVariants} — Anthropic's GA
   * families report `low…max`, an OpenAI-native model `minimal…xhigh`, a
   * generic gateway `low/medium/high`. Empty/absent for a non-reasoning model.
   */
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
interface NormalizedModelsDevProvider {
  /** models.dev provider id this was sourced from. */
  modelsDevId: string
  name: string
  doc?: string
  npm?: string
  api?: string
  models: ModelsDevCatalogModel[]
}
type NormalizedModelsDevCatalog = Record<string, NormalizedModelsDevProvider>
/**
 * Fallback reasoning tiers for a reasoning-capable model whose provider we
 * can't place. The conservative three every OpenAI-compatible gateway accepts.
 *
 * This used to be what EVERY reasoning model got, which made
 * `ModelsDevCatalogModel.variants` a placeholder rather than data: an Anthropic
 * Opus 4.6 (low…max) and a gateway model (low/medium/high) reported the same
 * three tiers. {@link computeModelVariants} now resolves the real ladder from
 * the provider's wire surface.
 */
declare const REASONING_VARIANT_TIERS: readonly ["low", "medium", "high"]
/**
 * Map a driver npm package to one of our adapter ids. Default is
 * `openai-compatible` — the same long-tail fallback opencode uses, which lets
 * any OpenAI-Chat-dialect provider work without bespoke code.
 */
declare function deriveAdapterFromNpm(npm?: string): BuiltInProviderAdapterId
/**
 * Reasoning tiers for a model — empty unless the model is reasoning-capable AND
 * its provider exposes a depth control. `providerId` is the models.dev provider
 * id; without it we can't place the wire surface and fall back to the
 * conservative {@link REASONING_VARIANT_TIERS}.
 */
declare function computeModelVariants(model: ModelsDevModel, providerId?: string): string[]
/**
 * Expand `experimental.modes` into pseudo-model entries (opencode emits
 * `${model.id}-${mode}`). camelCases the provider body so it slots straight
 * into AI SDK options.
 */
declare function expandModelModes(model: ModelsDevModel): ModelsDevMode[]
/**
 * Translate a single models.dev model into our enriched shape. `provider` is
 * the owning models.dev provider (for npm/api inheritance).
 */
declare function mapModelsDevModel(
  provider: ModelsDevProvider,
  model: ModelsDevModel
): ModelsDevCatalogModel
/**
 * Normalize the full models.dev payload into a catalog keyed by *our* provider
 * ids, restricted to built-ins that have a models.dev entry. The 100+ models.dev
 * providers with no configuration path in the app (and our local/untracked
 * providers) are dropped — this also resolves id differences (zhipu→zhipuai).
 */
declare function normalizeModelsDevApi(api: ModelsDevApi): NormalizedModelsDevCatalog
interface BuildCatalogSnapshotOptions {
  revisionId: string
  generatedAt: string
  checksum: string
  builtInCatalog: readonly BuiltInProviderCatalogEntry[]
  certifiedProviderIds: ReadonlySet<string>
  includeExperimentalProviders?: boolean
}
/**
 * Project the existing static catalog and models.dev mapper into one revision.
 * Manual provider/model fields win; models.dev fills live metadata; static
 * rows remain the offline fallback.
 */
declare function buildCatalogSnapshotFromModelsDev(
  api: ModelsDevApi,
  options: BuildCatalogSnapshotOptions
): CatalogSnapshot
/** Fetch the live models.dev catalog. Throws on network / shape errors. */
declare function fetchModelsDevApi(): Promise<ModelsDevApi>

export {
  type BuildCatalogSnapshotOptions,
  MODELS_DEV_API_URL,
  type ModelsDevApi,
  type ModelsDevCatalogModel,
  type ModelsDevCost,
  type ModelsDevExperimentalMode,
  type ModelsDevLimit,
  type ModelsDevModalities,
  type ModelsDevMode,
  type ModelsDevModel,
  type ModelsDevProvider,
  type ModelsDevProviderOverride,
  type NormalizedModelsDevCatalog,
  type NormalizedModelsDevProvider,
  REASONING_VARIANT_TIERS,
  buildCatalogSnapshotFromModelsDev,
  computeModelVariants,
  deriveAdapterFromNpm,
  expandModelModes,
  fetchModelsDevApi,
  mapModelsDevModel,
  normalizeModelsDevApi,
}
