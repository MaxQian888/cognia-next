/**
 * Pure provider-settings → flat model list used by the composer model picker
 * and the eval run-config target picker. Extracted from
 * `components/chat/composer/model-picker.tsx` unchanged.
 */

import { PROVIDERS } from "@cognia/provider-types/provider"
import type {
  UserProviderSettings,
  CustomProviderSettings,
  ProviderModelDiscoveryEntry,
} from "@cognia/provider-types/provider"
import { getModelDisplayName } from "@/lib/ai/icons"
import { getCachedOpenRouterCatalogModels } from "@cognia/provider-core/providers/openrouter-catalog-sync"

/**
 * The synced OpenRouter live-models catalog (Dexie v93), as the synchronous
 * model picker sees it. For the `openrouter` provider this stands in for the old
 * per-account `discoveredModels` list: it is the auto-synced, real-time `/models`
 * catalog shared identically across the GUI and the CLI. Returns `[]` until the
 * cache is primed (first boot, before the first network sync), so the picker then
 * degrades to the curated static `PROVIDERS.openrouter.models` subset.
 */
function openRouterCatalogModels(): ProviderModelDiscoveryEntry[] {
  return getCachedOpenRouterCatalogModels()
}

/** Look up a single OpenRouter catalog entry by model id (synchronous). */
function openRouterCatalogEntry(modelId: string): ProviderModelDiscoveryEntry | undefined {
  return openRouterCatalogModels().find((m) => m.id === modelId)
}

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
  // OpenRouter's per-account list is the synced catalog; everyone else uses the
  // settings-store `discoveredModels`.
  const discovered =
    providerId === "openrouter"
      ? openRouterCatalogEntry(modelId)
      : providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)
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
    const discovered =
      providerId === "openrouter"
        ? openRouterCatalogEntry(modelId)?.name
        : providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)?.name
    if (discovered) return discovered
  }
  return getModelDisplayName(modelId)
}

/**
 * Resolve the per-model context-window length (in tokens) from explicitly
 * declared metadata, in the same authoritative order the model picker uses
 * ({@link resolveModelMeta}): the user's custom-provider model metadata first,
 * then live-discovered models, then the built-in `PROVIDERS` catalog. Returns
 * `undefined` only when no catalog knows the model, so the caller falls back to
 * the curated pattern table in `lib/claude/usage.ts`.
 *
 * Consulting the built-in catalog here is what keeps the context indicator (and
 * the `/cost` / `/context` diagnostics) in lock-step with the picker: both now
 * read a built-in model's window from the catalog, so a model like `gpt-5.4`
 * (1M in the catalog, but unmatched by the regex table → 200k default) is sized
 * identically in both places instead of disagreeing.
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
  const discovered =
    providerId === "openrouter"
      ? openRouterCatalogEntry(modelId)
      : providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)
  const discoveredLen = positive(discovered?.contextLength)
  if (discoveredLen) return discoveredLen
  const builtin = PROVIDERS[providerId]?.models?.find((m) => m.id === modelId)
  return positive(builtin?.contextLength)
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
 * Model ids a provider can plausibly serve, from the same synchronous sources
 * the picker uses: the user's whitelist/default/discovery for built-ins (plus
 * the synced OpenRouter catalog and the curated static catalog), or the custom
 * provider's own model list.
 */
function servableModelIds(
  providerId: string,
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined
): Set<string> {
  const ids = new Set<string>()
  const cp = customProviders?.find((c) => c.id === providerId)
  if (cp) {
    if (cp.defaultModel) ids.add(cp.defaultModel)
    for (const mid of cp.customModels ?? []) ids.add(mid)
    for (const m of cp.models ?? []) {
      const mid = typeof m === "string" ? m : (m as { id?: string }).id
      if (mid) ids.add(mid)
    }
    return ids
  }
  const settings = providerSettings?.[providerId]
  for (const mid of settings?.enabledModels ?? []) ids.add(mid)
  if (settings?.defaultModel) ids.add(settings.defaultModel)
  for (const m of settings?.discoveredModels ?? []) {
    if (m?.id) ids.add(m.id)
  }
  if (providerId === "openrouter") {
    for (const m of openRouterCatalogModels()) {
      if (m?.id) ids.add(m.id)
    }
  }
  for (const mid of catalogModelIds(providerId)) ids.add(mid)
  return ids
}

/**
 * The `defaultModel` that should accompany a `defaultProvider` switch, keeping
 * the (model, provider) pair coherent: switching the default provider while a
 * foreign `defaultModel` sticks around sends that model to the new provider's
 * base URL (or, worse, keeps routing turns to the OLD provider's endpoint).
 *
 * Returns `undefined` when the current default model is already servable by
 * the new provider (keep it — never clobber a deliberate choice), or when the
 * provider is unknown and no replacement can be derived. Otherwise returns
 * the provider's own configured default → catalog default → first known model.
 */
export function resolveDefaultModelForProvider(
  providerId: string,
  currentDefaultModel: string | undefined,
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined
): string | undefined {
  const servable = servableModelIds(providerId, providerSettings, customProviders)
  if (currentDefaultModel && servable.has(currentDefaultModel)) return undefined
  const cp = customProviders?.find((c) => c.id === providerId)
  if (cp) {
    if (cp.defaultModel) return cp.defaultModel
    const first = servable.values().next()
    return first.done ? undefined : first.value
  }
  const configured = providerSettings?.[providerId]?.defaultModel
  if (configured) return configured
  const catalogDefault = PROVIDERS[providerId]?.defaultModel
  if (catalogDefault) return catalogDefault
  const first = servable.values().next()
  return first.done ? undefined : first.value
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
    // OpenRouter's full real-time list lives in the synced catalog (Dexie v93),
    // not `discoveredModels` — fold every catalogued id in so the picker shows
    // the whole live `/models` catalog, auto-synced and shared with the CLI.
    if (providerId === "openrouter") {
      for (const m of openRouterCatalogModels()) {
        if (m?.id) allowed.add(m.id)
      }
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
