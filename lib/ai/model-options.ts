/**
 * Pure provider-settings → flat model list used by the composer model picker
 * and the eval run-config target picker. Extracted from
 * `components/chat/composer/model-picker.tsx` unchanged.
 */

import { getAllProviders } from "@cognia/provider-types/provider"
import type {
  UserProviderSettings,
  CustomProviderSettings,
  ProviderModelDiscoveryEntry,
} from "@cognia/provider-types/provider"
import { getModelDisplayName } from "@/lib/ai/icons"
import { getCachedOpenRouterCatalogModels } from "@cognia/provider-core/providers/openrouter-catalog-sync"
import {
  getCatalogModelMetadata,
  resolveProviderModelLifecycle,
} from "@cognia/provider-core/providers/models-dev-sync"
import {
  isModelLifecycleAllowed,
  type ModelLifecycle,
  type ModelLifecycleInfo,
} from "@cognia/provider-types/model-catalog"
import {
  customProviderModelIds,
  catalogModelIds as sharedCatalogModelIds,
} from "@cognia/provider-routing/model-option-source"
import { isBuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"
import {
  remoteHostKeyedProviders,
  withRemoteHostKeyedProviders,
} from "@/lib/host-secrets/remote-host-keys"

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

type ModelMetadata = Omit<ProviderModelDiscoveryEntry, "id" | "name" | "provider" | "knownFields">

export interface ModelOption extends ModelMetadata {
  lifecycle?: ModelLifecycle
  disabled?: boolean
  replacementModelId?: string
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

/** Synchronous lifecycle authority shared by the GUI and CLI model lists. */
export function resolveModelLifecycle(
  providerId: string,
  modelId: string,
  status?: string
): ModelLifecycleInfo {
  const staticModel = getAllProviders()[providerId]?.models.find((model) => model.id === modelId)
  return resolveProviderModelLifecycle(
    providerId,
    modelId,
    status,
    staticModel?.status,
    providerId === "openrouter" ? openRouterCatalogEntry(modelId)?.status : undefined
  )
}

/**
 * Resolve the synchronously-available display metadata for a model — context
 * window + capability flags — from the most authoritative source first: the
 * user's custom-provider metadata, then live `/v1/models` discovery, then the
 * reviewed built-in `PROVIDERS` catalog, then the primed models.dev cache. Returns an empty
 * object when nothing is known. Reading the cache is synchronous and never
 * starts a network or database request during render.
 */
export function resolveModelMeta(
  providerId: string | undefined,
  modelId: string,
  providerSettings?: Record<string, UserProviderSettings>,
  customProviders?: CustomProviderSettings[],
  catalog = getAllProviders()
): ModelMetadata {
  if (!providerId) return {}
  const custom = customProviders?.find((c) => c.id === providerId)
  const cpm = custom?.customModelMetadata?.[modelId]
  // OpenRouter's per-account list is the synced catalog; everyone else uses the
  // settings-store `discoveredModels`.
  const discovered =
    providerId === "openrouter"
      ? openRouterCatalogEntry(modelId)
      : (custom?.discoveredModels ?? providerSettings?.[providerId]?.discoveredModels)?.find(
          (m) => m.id === modelId
        )
  const builtin = catalog[providerId]?.models?.find((m) => m.id === modelId)
  const baseline = getCatalogModelMetadata(providerId, modelId)
  const curated = cpm
    ? {
        ...cpm,
        supportsTools: cpm.supportsTools ?? cpm.capabilities?.functionCalling,
        supportsVision: cpm.supportsVision ?? cpm.capabilities?.vision,
        supportsStreaming: cpm.supportsStreaming ?? cpm.capabilities?.streaming,
      }
    : undefined
  // User overrides win for ordinary custom providers; subscription declarations
  // are fallback metadata, so account-specific discovery takes precedence.
  // Reviewed bundled values beat an older persisted catalog revision.
  const sources = custom?.subscription
    ? [baseline, builtin, curated, discovered]
    : [baseline, builtin, discovered, curated]
  const fields = [
    "contextLength",
    "maxInputTokens",
    "maxOutputTokens",
    "supportsTools",
    "supportsVision",
    "supportsAudio",
    "supportsVideo",
    "supportsStreaming",
    "supportsReasoning",
    "supportsTemperature",
    "supportsImageGeneration",
    "supportsEmbedding",
    "supportsStructuredOutput",
    "pricing",
  ] as const
  const result: ModelMetadata = {}
  for (const source of sources) {
    if (!source) continue
    for (const field of fields) {
      const value = source[field]
      if (value === undefined || (source.knownFields && !source.knownFields.includes(field)))
        continue
      if (
        (field === "contextLength" || field === "maxInputTokens" || field === "maxOutputTokens") &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      )
        continue
      Object.assign(result, { [field]: value })
    }
  }
  return result
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
  customProviders?: CustomProviderSettings[],
  catalog = getAllProviders()
): string {
  if (providerId) {
    const cp = customProviders?.find((c) => c.id === providerId)
    const live = (cp?.discoveredModels ?? providerSettings?.[providerId]?.discoveredModels)?.find(
      (m) => m.id === modelId
    )
    if (!isBuiltInProviderId(providerId) && (!cp || cp.subscription) && live?.name) return live.name
    const cpName = cp?.customModelMetadata?.[modelId]?.name
    if (cpName) return cpName
    const builtin = catalog[providerId]?.models?.find((m) => m.id === modelId)?.name
    if (builtin) return builtin
    const discovered =
      providerId === "openrouter"
        ? openRouterCatalogEntry(modelId)?.name
        : providerSettings?.[providerId]?.discoveredModels?.find((m) => m.id === modelId)?.name
    if (discovered) return discovered
  } else {
    // No provider to scope by (a character or session that follows the global
    // default): a built-in catalog id still has exactly one friendly name, and
    // dated ids like `claude-haiku-4-5-20251001` are absent from the alias
    // table below, so without this scan the raw id reached the UI.
    for (const provider of Object.values(catalog)) {
      const name = provider?.models?.find((m) => m.id === modelId)?.name
      if (name) return name
    }
  }
  return getModelDisplayName(modelId)
}

/**
 * The shortest label that still names a model, for a chip with room for a
 * handful of characters (the composer's model chip on a phone).
 *
 * A friendly name spends its first word on the vendor ("Claude Sonnet 4.6",
 * OpenRouter's "Anthropic: Claude Sonnet 4.5"), so an ellipsis at ten
 * characters kept exactly the part that does not tell two models apart:
 * every Anthropic model read "Claude S…". This drops what is shared and keeps
 * what differs:
 *
 *  - a `Vendor: ` prefix;
 *  - the directory of a raw routed id (`anthropic/claude-sonnet-4` → its last
 *    segment);
 *  - the leading `Claude` family word, which every Anthropic model carries,
 *    whose tier word ("Sonnet", "Haiku", "Opus") is the actual name.
 *
 * Other vendors' names are left whole: in "GPT-5" or "Gemini 2.5 Pro" the
 * first word IS the model family, and "2.5 Pro" alone would name nothing. The
 * full name stays the chip's title and accessible name.
 */
export function compactModelLabel(name: string): string {
  let label = name.trim()
  const vendorColon = label.indexOf(": ")
  if (vendorColon > 0 && vendorColon < label.length - 2) label = label.slice(vendorColon + 2)
  if (!/\s/.test(label) && label.includes("/")) {
    const last = label.slice(label.lastIndexOf("/") + 1)
    if (last) label = last
  }
  const withoutFamily = label.replace(/^claude[\s-]+/i, "")
  return withoutFamily.length > 0 ? withoutFamily : label
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
  return resolveModelMeta(providerId, modelId, providerSettings, customProviders).contextLength
}

/** Known output cap for the actual selected model, including account-specific discovery. */
export function resolveModelMaxOutputTokens(
  modelId: string | undefined,
  providerId: string | undefined,
  providerSettings?: Record<string, UserProviderSettings>,
  customProviders?: CustomProviderSettings[]
): number | undefined {
  if (!modelId || !providerId) return undefined
  return resolveModelMeta(providerId, modelId, providerSettings, customProviders).maxOutputTokens
}

/**
 * Curated fallback list for a provider the user enabled but never configured
 * models for. Sourced from the static built-in `PROVIDERS` registry (a short
 * hand-picked list per provider), NOT the models.dev catalog — see the
 * comment inside {@link collectModelOptions} for why the latter is unsuitable.
 */
export function catalogModelIds(providerId: string, catalog = getAllProviders()): string[] {
  return sharedCatalogModelIds(providerId, catalog)
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
  const catalogDefault = catalogModelIds(providerId)[0]
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
 *
 * A provider the driven `/pair` Host holds a sealed key for (`hostKeyed`,
 * ADR-0224 A6) is listed too when this device has no key of its own for it:
 * the Host fills its key into the turn.
 */
export function collectModelOptions(
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined,
  hostKeyed: ReadonlySet<string> = remoteHostKeyedProviders()
): ModelOption[] {
  const catalog = getAllProviders()
  const out: ModelOption[] = []
  providerSettings = withRemoteHostKeyedProviders(providerSettings, hostKeyed)
  const entries = Object.entries(providerSettings ?? {})
  if (!entries.some(([id]) => id === "anthropic")) {
    entries.unshift(["anthropic", { providerId: "anthropic" } as UserProviderSettings])
  }
  for (const [providerId, settings] of entries) {
    if (settings.enabled === false) continue
    if (providerId.includes(":") && !catalog[providerId]) continue
    // Selectable models = what the user has configured (enabledModels whitelist
    // + defaultModel) plus what live /v1/models discovery confirmed for *their*
    // account (discoveredModels). The models.dev catalog is a global metadata
    // registry, NOT a per-account availability source — surfacing it here would
    // list hundreds of models the user's key/tier can't serve, which 4xx at
    // send time. models.dev still enriches pricing/caps in the settings views.
    const pins = new Set<string>(settings.enabledModels ?? [])
    if (settings.defaultModel) pins.add(settings.defaultModel)
    const allowed = new Set<string>(pins)
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
    const providerName = catalog[providerId]?.name ?? providerId
    const candidates = allowed.size > 0 ? [...allowed] : catalogModelIds(providerId, catalog)
    const modelIds = candidates.filter((modelId) => {
      const discovered =
        providerId === "openrouter"
          ? openRouterCatalogEntry(modelId)
          : settings.discoveredModels?.find((model) => model.id === modelId)
      return (
        pins.has(modelId) ||
        isModelLifecycleAllowed(
          resolveModelLifecycle(providerId, modelId, discovered?.status).lifecycle,
          "new"
        )
      )
    })
    // A retired saved pin remains explainable, with a current alternative to
    // choose. Never rewrite the user's settings or historical session rows.
    if (
      !modelIds.some((modelId) =>
        isModelLifecycleAllowed(resolveModelLifecycle(providerId, modelId).lifecycle, "new")
      )
    ) {
      const recommended = catalogModelIds(providerId, catalog)[0]
      if (recommended && !modelIds.includes(recommended)) modelIds.push(recommended)
    }
    for (const modelId of modelIds) {
      const discovered =
        providerId === "openrouter"
          ? openRouterCatalogEntry(modelId)
          : settings.discoveredModels?.find((model) => model.id === modelId)
      const lifecycle = resolveModelLifecycle(providerId, modelId, discovered?.status)
      out.push({
        providerId,
        providerName,
        modelId,
        modelName: resolveModelDisplayName(
          providerId,
          modelId,
          providerSettings,
          customProviders,
          catalog
        ),
        ...resolveModelMeta(providerId, modelId, providerSettings, customProviders, catalog),
        lifecycle: lifecycle.lifecycle,
        disabled: !isModelLifecycleAllowed(lifecycle.lifecycle, "new"),
        replacementModelId: lifecycle.replacementModelId,
      })
    }
  }
  for (const cp of customProviders ?? []) {
    if (cp.enabled === false) continue
    // Shared with the routing engine's candidate source. Reading `models` as
    // `{id}` objects here (which is what this loop used to do) silently
    // dropped every custom-provider model, because the field is `string[]`.
    for (const modelId of customProviderModelIds(cp)) {
      const metadata = resolveModelMeta(cp.id, modelId, providerSettings, customProviders, catalog)
      const lifecycle = resolveProviderModelLifecycle(
        cp.id,
        modelId,
        cp.discoveredModels?.find((model) => model.id === modelId)?.status
      )
      out.push({
        providerId: cp.id,
        providerName: cp.name ?? cp.id,
        modelId,
        modelName: resolveModelDisplayName(
          cp.id,
          modelId,
          providerSettings,
          customProviders,
          catalog
        ),
        ...metadata,
        lifecycle: lifecycle.lifecycle,
        disabled: !isModelLifecycleAllowed(lifecycle.lifecycle, "new"),
        replacementModelId: lifecycle.replacementModelId,
      })
    }
  }
  return out
}
