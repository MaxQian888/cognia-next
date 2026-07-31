/**
 * models.dev catalog sync orchestration.
 *
 * Layers on top of the raw mapper (`models-dev.ts`) and the Dexie cache
 * (`lib/db/models-dev-catalog.ts`):
 *  - {@link syncModelsDevCatalog} — fetch live → normalize → persist.
 *  - {@link ensureModelsDevCatalog} — read cache, seeding the bundled offline
 *    snapshot on first run.
 *  - {@link refreshModelsDevCatalogIfStale} — app-start hook; background-refresh
 *    if older than the threshold, swallowing errors.
 *  - {@link getCatalogModelsForProvider} / {@link getCatalogModelMetadata} —
 *    synchronous reads over an in-memory cache for UI render paths.
 *  - {@link resolveProviderAdapter} — provider-level adapter (static catalog
 *    wins; models.dev-derived fills the gap; `openai-compatible` last).
 *
 * The bundled snapshot is dynamic-imported only here so the ~MB JSON is
 * code-split out of the main bundle.
 */

import {
  getBuiltInProviderAdapter,
  getBuiltInProviderCatalog,
} from "@cognia/provider-types/built-in-provider-catalog"
import type { BuiltInProviderAdapterId } from "@cognia/provider-types/built-in-provider-catalog"
import {
  getModelsDevCatalog,
  isModelsDevCatalogStale,
  loadModelsDevSnapshot,
  saveModelsDevCatalog,
  MODELS_DEV_STALE_MS,
  type ModelsDevCatalogRow,
} from "./models-dev-catalog-db"
import {
  buildCatalogSnapshotFromModelsDev,
  deriveAdapterFromNpm,
  fetchModelsDevApi,
  normalizeModelsDevApi,
  type ModelsDevApi,
  type ModelsDevCatalogModel,
} from "./models-dev"
import type { CatalogRepository } from "./catalog-repository"
import { BUNDLED_CERTIFIED_PROVIDER_IDS } from "./catalog-baseline"
import { resolveModelsDevProviderId } from "./models-dev-id-map"

// =============================================================================
// In-memory cache (for synchronous UI reads; primed by sync/ensure + the hook)
// =============================================================================

let cachedCatalog: ModelsDevCatalogRow | null = null
let catalogRepository: CatalogRepository | null = null
let includeExperimentalProviders = true

/**
 * Wire the single catalog repository used by the host runtime. Optional for
 * headless package consumers that only need the legacy normalized projection.
 */
export function setProviderCatalogRepository(repository: CatalogRepository | null): void {
  catalogRepository = repository
}

export function setProviderCatalogRollout(options: {
  includeExperimentalProviders: boolean
}): void {
  includeExperimentalProviders = options.includeExperimentalProviders
}

/** Prime the synchronous in-memory cache (called by the liveQuery hook). */
export function primeModelsDevCatalogCache(row: ModelsDevCatalogRow | null | undefined): void {
  cachedCatalog = row ?? null
}

export function getCachedModelsDevCatalog(): ModelsDevCatalogRow | null {
  return cachedCatalog
}

/** Test-only reset. */
export function __resetModelsDevCatalogCacheForTesting(): void {
  cachedCatalog = null
}

// =============================================================================
// Sync / ensure / refresh
// =============================================================================

let inFlightSync: Promise<ModelsDevCatalogRow> | null = null

/** Guard against upstream truncation replacing a healthy local revision. */
export const MODELS_DEV_MIN_RETENTION_RATIO = 0.75

function catalogSize(providers: ModelsDevCatalogRow["providers"]): {
  providers: number
  models: number
} {
  const entries = Object.values(providers)
  return {
    providers: entries.length,
    models: entries.reduce((total, provider) => total + provider.models.length, 0),
  }
}

function validateRefreshCandidate(
  candidate: ModelsDevCatalogRow["providers"],
  previous: ModelsDevCatalogRow | undefined
): void {
  const nextSize = catalogSize(candidate)
  if (nextSize.providers === 0 || nextSize.models === 0) {
    throw new Error("models.dev refresh is empty; keeping last-known-good catalog")
  }
  if (!previous) return

  const previousSize = catalogSize(previous.providers)
  const providerRatio = nextSize.providers / Math.max(previousSize.providers, 1)
  const modelRatio = nextSize.models / Math.max(previousSize.models, 1)
  if (
    providerRatio < MODELS_DEV_MIN_RETENTION_RATIO ||
    modelRatio < MODELS_DEV_MIN_RETENTION_RATIO
  ) {
    throw new Error(
      `models.dev refresh shrank abnormally ` +
        `(${nextSize.providers}/${previousSize.providers} providers, ` +
        `${nextSize.models}/${previousSize.models} models); keeping last-known-good catalog`
    )
  }
}

async function checksumApi(api: ModelsDevApi): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("Web Crypto is unavailable; catalog checksum cannot be verified")
  const bytes = new TextEncoder().encode(JSON.stringify(api))
  const digest = await subtle.digest("SHA-256", bytes)
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  return `sha256:${hex}`
}

async function publishUnifiedCatalog(api: ModelsDevApi, now: number): Promise<void> {
  if (!catalogRepository) return
  const checksum = await checksumApi(api)
  const revisionId = `${now}-${checksum.slice("sha256:".length, "sha256:".length + 12)}`
  const snapshot = buildCatalogSnapshotFromModelsDev(api, {
    revisionId,
    generatedAt: new Date(now).toISOString(),
    checksum,
    builtInCatalog: getBuiltInProviderCatalog(),
    certifiedProviderIds: BUNDLED_CERTIFIED_PROVIDER_IDS,
    includeExperimentalProviders,
  })
  await catalogRepository.stageRevision(snapshot)
  await catalogRepository.activateRevision(revisionId)
}

/** Seed Catalog v2 from the bundled shard when no active revision is loaded. */
export async function ensureUnifiedProviderCatalog(now: number = Date.now()): Promise<void> {
  if (!catalogRepository || catalogRepository.listProviders().length > 0) return
  const api = await loadBundledSnapshot()
  await publishUnifiedCatalog(api, now)
}

/** Fetch the live models.dev catalog, normalize, persist, and prime the cache. */
export async function syncModelsDevCatalog(now: number = Date.now()): Promise<ModelsDevCatalogRow> {
  // Coalesce concurrent syncs (manual button + stale auto-refresh racing).
  if (inFlightSync) return inFlightSync
  inFlightSync = (async () => {
    const api = await fetchModelsDevApi()
    const providers = normalizeModelsDevApi(api)
    const previous = await getModelsDevCatalog()
    validateRefreshCandidate(providers, previous)
    const row = await saveModelsDevCatalog({ providers, fetchedAt: now, source: "remote" })
    await publishUnifiedCatalog(api, now)
    cachedCatalog = row
    return row
  })()
  try {
    return await inFlightSync
  } finally {
    inFlightSync = null
  }
}

/**
 * Read the cached catalog, seeding the bundled offline snapshot on first run so
 * the app is never empty (even offline / before the first network sync).
 */
export async function ensureModelsDevCatalog(
  now: number = Date.now()
): Promise<ModelsDevCatalogRow> {
  const existing = await getModelsDevCatalog()
  if (existing) {
    cachedCatalog = existing
    return existing
  }
  const api = await loadBundledSnapshot()
  const providers = normalizeModelsDevApi(api)
  const row = await saveModelsDevCatalog({ providers, fetchedAt: now, source: "bundled" })
  await publishUnifiedCatalog(api, now)
  cachedCatalog = row
  return row
}

/**
 * App-start hook: ensure a catalog exists (seed bundled), then refresh in the
 * background if stale. Never throws — a failed refresh leaves the existing
 * (bundled or older remote) catalog in place.
 */
export async function refreshModelsDevCatalogIfStale(
  maxAgeMs: number = MODELS_DEV_STALE_MS,
  now: number = Date.now()
): Promise<void> {
  try {
    await ensureModelsDevCatalog(now)
  } catch {
    // Even seeding failed (e.g. snapshot import error) — nothing else to do.
    return
  }
  try {
    if (await isModelsDevCatalogStale(maxAgeMs, now)) {
      await syncModelsDevCatalog(now)
    }
  } catch {
    // Background refresh failure is non-fatal; keep the cached catalog.
  }
}

/** Dynamic-import the bundled raw snapshot (code-split out of the main bundle). */
async function loadBundledSnapshot(): Promise<ModelsDevApi> {
  return loadModelsDevSnapshot()
}

// =============================================================================
// Synchronous reads (UI render paths)
// =============================================================================

/** models.dev models for a provider, from the in-memory cache. */
export function getCatalogModelsForProvider(providerId: string): ModelsDevCatalogModel[] {
  if (catalogRepository) {
    const offerings = catalogRepository
      .listOfferings()
      .filter((offering) => offering.providerRef === providerId)
    const seen = new Set<string>()
    const projected: ModelsDevCatalogModel[] = []
    for (const offering of offerings) {
      if (seen.has(offering.upstreamId)) continue
      const model = catalogRepository.getModel(offering.modelRef)
      if (!model) continue
      seen.add(offering.upstreamId)
      projected.push({
        id: offering.upstreamId,
        name: model.name,
        provider: providerId,
        family: model.family,
        releaseDate: model.releasedAt,
        status: model.lifecycle,
        contextLength: offering.limits?.context ?? model.limits?.context,
        maxOutputTokens: offering.limits?.output ?? model.limits?.output,
        supportsTools: offering.capabilities?.tools ?? model.capabilities.tools,
        supportsVision: model.modalities.input.includes("image"),
        supportsAudio:
          model.modalities.input.includes("audio") || model.modalities.output.includes("audio"),
        supportsVideo:
          model.modalities.input.includes("video") || model.modalities.output.includes("video"),
        supportsStreaming: offering.capabilities?.streaming ?? model.capabilities.streaming,
        supportsReasoning: offering.capabilities?.reasoning ?? model.capabilities.reasoning,
        supportsImageGeneration:
          offering.capabilities?.imageGeneration ?? model.capabilities.imageGeneration,
        supportsEmbedding: offering.capabilities?.embeddings ?? model.capabilities.embeddings,
        supportsStructuredOutput:
          offering.capabilities?.structuredOutput ?? model.capabilities.structuredOutput,
        supportsAttachment: offering.capabilities?.attachments ?? model.capabilities.attachments,
        openWeights: offering.capabilities?.openWeights ?? model.capabilities.openWeights,
        supportsTemperature: offering.capabilities?.temperature ?? model.capabilities.temperature,
        pricing: offering.pricing
          ? {
              promptPer1M: offering.pricing.inputPer1M,
              completionPer1M: offering.pricing.outputPer1M,
              cachedInputPer1M: offering.pricing.cachedInputPer1M,
              cacheCreationPer1M: offering.pricing.cacheWritePer1M,
              currency: offering.pricing.currency,
            }
          : undefined,
      })
    }
    if (projected.length > 0) return projected
  }
  return cachedCatalog?.providers[providerId]?.models ?? []
}

/** Metadata for a single (provider, model) from the in-memory cache. */
export function getCatalogModelMetadata(
  providerId: string,
  modelId: string
): ModelsDevCatalogModel | undefined {
  return getCatalogModelsForProvider(providerId).find((m) => m.id === modelId)
}

/**
 * Resolve a provider's adapter/driver. Provider-level config is authoritative,
 * so the static catalog wins; models.dev's npm-derived adapter fills the gap
 * for providers the static catalog leaves unspecified; `openai-compatible` is
 * the final long-tail fallback.
 */
export function resolveProviderAdapter(providerId: string): BuiltInProviderAdapterId {
  const staticAdapter = getBuiltInProviderAdapter(providerId)
  if (staticAdapter) return staticAdapter
  const devId = resolveModelsDevProviderId(providerId)
  if (devId) {
    const entry = cachedCatalog?.providers[providerId]
    if (entry?.npm) return deriveAdapterFromNpm(entry.npm)
    // Fall back to any model-level adapter hint we cached.
    const modelAdapter = entry?.models.find((m) => m.adapter)?.adapter
    if (modelAdapter) return modelAdapter
  }
  return "openai-compatible"
}
