/**
 * Per-twin embedding resolution — pure functions only.
 *
 * Every twin used to embed with the one global `TwinRuntimeSettings.embedding`
 * and nothing recorded which model built a twin's vectors, so two models with
 * the same output dimension (cohere / mistral / voyage / bedrock are all 1024)
 * silently returned wrong neighbours. A twin may now carry its own
 * `Twin.embedding` override, and ingest records `Twin.embeddingIndex`.
 *
 * Precedence of the effective embedding for a twin:
 *   1. `Twin.embedding` (provider + optional model; blank model → the catalog
 *      default for that provider).
 *   2. The global `TwinRuntimeSettings.embedding`.
 *
 * Credentials for an override are never stored on the twin row:
 *   - same provider as the global config → reuse the global key / baseURL /
 *     Bedrock settings the user already entered for the twin runtime;
 *   - another provider → the shared chat-provider settings, resolved the way
 *     the plugin vector API does it (`resolveEmbeddingApiKey`), plus the local
 *     engine's base URL (provider settings, then its default localhost port).
 *
 * Index fingerprint format: `${provider}::${model}::${dimensions}` (dimensions
 * `unknown` when not observed). Match checks compare provider + model only;
 * dimensions stay the job of the existing dimension guard.
 */

import {
  embeddingProviderRequiresApiKey,
  embeddingProviderRequiresBaseURL,
  expectedEmbeddingDimension,
  getEmbeddingProviderDescriptor,
  type RagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"
import { embeddingProviderSettingsKey, resolveEmbeddingApiKey } from "@cognia/vector/embedding"
import { LOCAL_PROVIDER_URLS, type BedrockConnectionSettings } from "@cognia/provider-types"
import type {
  TwinEmbeddingIndexRecord,
  TwinEmbeddingOverride,
  TwinRuntimeEmbeddingSettings,
} from "@/types/twin"

/** Machine-readable degradation / failure code for a stale twin index. */
export const TWIN_EMBEDDING_REBUILD_REQUIRED = "rebuild-required"
/** Machine-readable code for a twin whose effective embedding has no credentials. */
export const TWIN_EMBEDDING_UNCONFIGURED = "twin-embedding-unconfigured"

export type TwinEmbeddingSource = "twin" | "global"

/** Chat-provider settings slice the resolver reads (apiKey / baseURL / bedrock). */
export type EmbeddingProviderSettingsMap = Record<
  string,
  { apiKey?: string; baseURL?: string; bedrock?: BedrockConnectionSettings } | undefined
>

export interface TwinEffectiveEmbedding {
  /** Ready-to-use config, including the resolved API key. */
  config: TwinRuntimeEmbeddingSettings
  source: TwinEmbeddingSource
  /** False when a required key / base URL / Bedrock connection is missing. */
  credentialsReady: boolean
}

export interface TwinEmbeddingModelRef {
  provider: RagEmbeddingProvider
  model: string
}

/**
 * Same readiness rule the runtime adapter builder has always applied to the
 * global config: a model, an API key for cloud providers, a base URL for
 * local engines.
 */
export function isTwinEmbeddingConfigReady(config: TwinRuntimeEmbeddingSettings): boolean {
  if (!config.model.trim()) return false
  if (embeddingProviderRequiresApiKey(config.provider) && !config.apiKey.trim()) return false
  if (embeddingProviderRequiresBaseURL(config.provider) && !config.baseURL?.trim()) return false
  return true
}

/** Normalise a stored override: trims the model, drops a blank one. */
export function normalizeTwinEmbeddingOverride(
  override: TwinEmbeddingOverride
): TwinEmbeddingOverride {
  const model = override.model?.trim()
  return model ? { provider: override.provider, model } : { provider: override.provider }
}

/** The model an override resolves to (explicit model, else the catalog default). */
export function twinOverrideModel(override: TwinEmbeddingOverride): string {
  return override.model?.trim() || getEmbeddingProviderDescriptor(override.provider).defaultModel
}

function localEngineDefaultURL(provider: RagEmbeddingProvider): string | undefined {
  return (LOCAL_PROVIDER_URLS as Record<string, string | undefined>)[provider]
}

/**
 * Resolve the embedding config a twin actually embeds with. Pure: the caller
 * supplies the twin's override, the global twin-runtime embedding (with its
 * key already hydrated) and the chat-provider settings map.
 */
export function resolveTwinEmbeddingConfig(input: {
  override?: TwinEmbeddingOverride
  global: TwinRuntimeEmbeddingSettings
  providerSettings?: EmbeddingProviderSettingsMap
}): TwinEffectiveEmbedding {
  const { override, global } = input
  if (!override) {
    return {
      config: global,
      source: "global",
      credentialsReady: isTwinEmbeddingConfigReady(global),
    }
  }
  const provider = override.provider
  const model = twinOverrideModel(override)
  if (provider === global.provider) {
    const config: TwinRuntimeEmbeddingSettings = { ...global, model }
    return { config, source: "twin", credentialsReady: isTwinEmbeddingConfigReady(config) }
  }

  const providerSettings = input.providerSettings ?? {}
  const settingsKey = embeddingProviderSettingsKey(provider)
  const shared = settingsKey ? providerSettings[settingsKey] : undefined
  const apiKey = resolveEmbeddingApiKey(
    provider,
    providerSettings as Parameters<typeof resolveEmbeddingApiKey>[1]
  )
  // Only engines that need a base URL take one from the chat-provider entry: a
  // cloud provider's chat base URL may be a chat-only proxy.
  const baseURL = embeddingProviderRequiresBaseURL(provider)
    ? shared?.baseURL?.trim() || localEngineDefaultURL(provider)
    : undefined
  const bedrock = provider === "amazon-bedrock" ? shared?.bedrock : undefined
  const config: TwinRuntimeEmbeddingSettings = {
    provider,
    model,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(bedrock ? { bedrock } : {}),
  }
  const bedrockReady = provider !== "amazon-bedrock" || Boolean(bedrock || apiKey)
  return {
    config,
    source: "twin",
    credentialsReady: bedrockReady && isTwinEmbeddingConfigReady(config),
  }
}

/** `${provider}::${model}::${dimensions}` — the recorded index fingerprint. */
export function twinEmbeddingFingerprint(input: {
  provider: RagEmbeddingProvider
  model: string
  dimensions?: number
}): string {
  return `${input.provider}::${input.model}::${input.dimensions ?? "unknown"}`
}

/** Provider + model equality — the part of the fingerprint retrieval enforces. */
export function sameEmbeddingModel(a: TwinEmbeddingModelRef, b: TwinEmbeddingModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * True when the twin has a recorded index AND it was built with a different
 * provider/model than the effective config. A twin without a record (legacy
 * index, or nothing ingested yet) never reports rebuild-required.
 */
export function twinIndexRebuildRequired(
  effective: TwinEmbeddingModelRef,
  index: TwinEmbeddingIndexRecord | undefined
): boolean {
  return Boolean(index) && !sameEmbeddingModel(effective, index!)
}

/** `rebuild-required: …` reason string surfaced by retrieval and ingest. */
export function describeTwinIndexMismatch(
  effective: TwinEmbeddingModelRef,
  index: TwinEmbeddingIndexRecord
): string {
  return (
    `${TWIN_EMBEDDING_REBUILD_REQUIRED}: the twin index was built with ${index.fingerprint} ` +
    `but the twin now embeds with ${effective.provider}::${effective.model}; rebuild the twin index`
  )
}

/** Catalog-expected dimension for the effective model (UI hint only). */
export function expectedTwinEmbeddingDimensions(ref: TwinEmbeddingModelRef): number | undefined {
  return expectedEmbeddingDimension(ref.provider, ref.model)
}

/** Build the index record ingest persists on the twin row. */
export function buildTwinEmbeddingIndexRecord(input: {
  provider: RagEmbeddingProvider
  model: string
  dimensions?: number
  builtAt: number
}): TwinEmbeddingIndexRecord {
  return {
    provider: input.provider,
    model: input.model,
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
    fingerprint: twinEmbeddingFingerprint(input),
    builtAt: input.builtAt,
  }
}
