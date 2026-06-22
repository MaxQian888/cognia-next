/**
 * Pure provider-settings → flat model list used by the composer model picker
 * and the eval run-config target picker. Extracted from
 * `components/chat/composer/model-picker.tsx` unchanged.
 */

import { PROVIDERS } from "@cognia/provider-types/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@cognia/provider-types/provider"
import { getModelDisplayName } from "@/lib/ai/icons"

export interface ModelOption {
  providerId: string
  /** Human-readable provider name (e.g. "Anthropic"), not the raw id. */
  providerName: string
  modelId: string
  /** Human-readable model name (e.g. "Claude Sonnet 4.5"); falls back to the id. */
  modelName: string
  /** Context window in tokens, when synchronously known (catalog/discovered/custom). */
  contextLength?: number
  /** Tool-calling support, when known. */
  supportsTools?: boolean
  /** Vision/image-input support, when known. */
  supportsVision?: boolean
  /** Reasoning/thinking support, when known. */
  supportsReasoning?: boolean
}

/**
 * Resolve the synchronously-available display metadata for a model — context
 * window + capability flags — from the most authoritative source first: the
 * user's custom-provider metadata, then live `/v1/models` discovery, then the
 * built-in `PROVIDERS` catalog. Returns an empty object when nothing is known
 * (so the picker simply omits the metadata line for that row). models.dev is a
 * Dexie-backed async catalog and intentionally NOT consulted here — the picker
 * renders synchronously off the settings store.
 */
export function resolveModelMeta(
  providerId: string | undefined,
  modelId: string,
  providerSettings?: Record<string, UserProviderSettings>,
  customProviders?: CustomProviderSettings[]
): Pick<ModelOption, "contextLength" | "supportsTools" | "supportsVision" | "supportsReasoning"> {
  if (!providerId) return {}
  const cpm = customProviders?.find((c) => c.id === providerId)?.customModelMetadata?.[modelId]
  const discovered = providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)
  const builtin = PROVIDERS[providerId]?.models?.find((m) => m.id === modelId)
  const firstDefined = <T>(...vals: (T | undefined)[]): T | undefined =>
    vals.find((v) => v !== undefined)
  return {
    contextLength: firstDefined(
      cpm?.contextLength,
      discovered?.contextLength,
      builtin?.contextLength
    ),
    supportsTools: firstDefined(
      cpm?.capabilities?.functionCalling,
      discovered?.supportsTools,
      builtin?.supportsTools
    ),
    supportsVision: firstDefined(
      cpm?.capabilities?.vision,
      discovered?.supportsVision,
      builtin?.supportsVision
    ),
    supportsReasoning: firstDefined(discovered?.supportsReasoning, builtin?.supportsReasoning),
  }
}

/**
 * Resolve a model id to its human-readable display name from the
 * synchronously-available metadata, preferring the most authoritative source:
 * the user's custom-provider metadata, then the built-in `PROVIDERS` catalog,
 * then the user's live `/v1/models` discovery, then the curated alias table in
 * `lib/ai/icons.ts` (which itself falls back to the raw id). Provider-scoped so
 * a model id is resolved against the provider it belongs to.
 */
export function resolveModelDisplayName(
  providerId: string | undefined,
  modelId: string,
  providerSettings?: Record<string, UserProviderSettings>,
  customProviders?: CustomProviderSettings[]
): string {
  if (providerId) {
    const cp = customProviders?.find((c) => c.id === providerId)
    const cpName = cp?.customModelMetadata?.[modelId]?.name
    if (cpName) return cpName
    const builtin = PROVIDERS[providerId]?.models?.find((m) => m.id === modelId)?.name
    if (builtin) return builtin
    const discovered = providerSettings?.[providerId]?.discoveredModels?.find(
      (m) => m.id === modelId
    )?.name
    if (discovered) return discovered
  }
  return getModelDisplayName(modelId)
}

/**
 * Resolve the per-model context-window length (in tokens) from explicitly
 * declared metadata only: the user's custom-provider model metadata first,
 * then their live-discovered models. Returns `undefined` for built-in catalog
 * models so the caller falls back to the curated pattern table in
 * `lib/claude/usage.ts` (the single source of truth for built-ins). This closes
 * the gap where a custom or account-discovered model with a non-200k window was
 * sized at the 200k default.
 */
export function resolveModelContextLength(
  modelId: string | undefined,
  providerId: string | undefined,
  providerSettings?: Record<string, UserProviderSettings>,
  customProviders?: CustomProviderSettings[]
): number | undefined {
  if (!modelId || !providerId) return undefined
  const positive = (n: number | undefined): number | undefined =>
    typeof n === "number" && n > 0 ? n : undefined
  const cp = customProviders?.find((c) => c.id === providerId)
  const cpLen = positive(cp?.customModelMetadata?.[modelId]?.contextLength)
  if (cpLen) return cpLen
  const discovered = providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)
  return positive(discovered?.contextLength)
}

/**
 * Curated fallback list for a provider the user enabled but never configured
 * models for. Sourced from the static built-in `PROVIDERS` registry (a short
 * hand-picked list per provider), NOT the models.dev catalog — see the
 * comment inside {@link collectModelOptions} for why the latter is unsuitable.
 */
export function catalogModelIds(providerId: string): string[] {
  const cfg = PROVIDERS[providerId]
  if (!cfg) return []
  const ids = new Set<string>()
  if (cfg.defaultModel) ids.add(cfg.defaultModel)
  for (const m of cfg.models ?? []) ids.add(m.id)
  return [...ids]
}

/**
 * Flatten the user's enabled providers + their model whitelists into a
 * single list the picker can render. Custom providers come last so the
 * built-ins lead the dropdown.
 *
 * Anthropic is always considered even without a `providerSettings` entry:
 * the sidecar runtime authenticates via API key or subscription OAuth
 * (ADR-0025) and needs no provider config, so subscription-reuse users must
 * still get a model list. An explicit `enabled: false` entry opts out.
 */
export function collectModelOptions(
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined
): ModelOption[] {
  const out: ModelOption[] = []
  const entries = Object.entries(providerSettings ?? {})
  if (!entries.some(([id]) => id === "anthropic")) {
    entries.unshift(["anthropic", { providerId: "anthropic" } as UserProviderSettings])
  }
  for (const [providerId, settings] of entries) {
    if (settings.enabled === false) continue
    // Selectable models = what the user has configured (enabledModels whitelist
    // + defaultModel) plus what live /v1/models discovery confirmed for *their*
    // account (discoveredModels). The models.dev catalog is a global metadata
    // registry, NOT a per-account availability source — surfacing it here would
    // list hundreds of models the user's key/tier can't serve, which 4xx at
    // send time. models.dev still enriches pricing/caps in the settings views.
    const allowed = new Set<string>(settings.enabledModels ?? [])
    if (settings.defaultModel) allowed.add(settings.defaultModel)
    for (const m of settings.discoveredModels ?? []) {
      if (m?.id) allowed.add(m.id)
    }
    // Nothing configured at all → fall back to the curated built-in catalog
    // so an enabled provider never renders as an empty group.
    const providerName = PROVIDERS[providerId]?.name ?? providerId
    const modelIds = allowed.size > 0 ? [...allowed] : catalogModelIds(providerId)
    for (const modelId of modelIds) {
      out.push({
        providerId,
        providerName,
        modelId,
        modelName: resolveModelDisplayName(providerId, modelId, providerSettings, customProviders),
        ...resolveModelMeta(providerId, modelId, providerSettings, customProviders),
      })
    }
  }
  for (const cp of customProviders ?? []) {
    if (cp.enabled === false) continue
    const ids = new Set<string>()
    if (cp.defaultModel) ids.add(cp.defaultModel)
    for (const m of cp.models ?? []) {
      const mid = (m as { id?: string }).id
      if (mid) ids.add(mid)
    }
    for (const modelId of ids) {
      out.push({
        providerId: cp.id,
        providerName: cp.name ?? cp.id,
        modelId,
        modelName: resolveModelDisplayName(cp.id, modelId, providerSettings, customProviders),
        ...resolveModelMeta(cp.id, modelId, providerSettings, customProviders),
      })
    }
  }
  return out
}
