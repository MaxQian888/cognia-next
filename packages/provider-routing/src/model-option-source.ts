/**
 * Shared provider+model option source for pickers.
 *
 * Extracted from `components/settings/agent-runtime/parts/default-model-picker.tsx`
 * so the routing alias editor's provider:model combobox and the default-model
 * picker present the exact same option universe (enabled providers, discovered
 * models, OpenRouter's synced catalog, curated built-in catalog fallback,
 * custom providers).
 *
 * This is also the routing engine's candidate universe
 * (`build-preview-engine.ts` builds `deps.listCandidates` from it), which is
 * why a picker and the router must never collect differently: a model a user
 * can select but the router cannot see is a routing bug wearing a UI costume.
 */

import { getCachedOpenRouterCatalogModels } from "@cognia/provider-core/providers/openrouter-catalog-sync"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@cognia/provider-types/provider"

export interface ModelOption {
  providerId: string
  providerName: string
  modelId: string
}

export interface ModelOptionGroup {
  providerId: string
  providerName: string
  models: string[]
}

/**
 * Curated fallback for an enabled-but-unconfigured provider — the static
 * built-in `PROVIDERS` registry, mirroring `composer/model-picker.tsx`.
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
 * Every model id a custom provider offers.
 *
 * `CustomProviderSettings` declares `models: string[]` and `customModels:
 * string[]`, the former documented as a convenience alias of the latter. Both
 * are read, and object entries are tolerated, because the two collectors that
 * predate this helper each read only one of them — and one read `models` as
 * `{id}` objects, so it always resolved `undefined` and dropped every custom
 * model. That was not a display bug: the routing engine builds its candidate
 * set from the same collector, so a custom provider with no `defaultModel`
 * contributed zero routing candidates.
 */
export function customProviderModelIds(cp: CustomProviderSettings): string[] {
  const ids = new Set<string>()
  if (cp.defaultModel) ids.add(cp.defaultModel)
  for (const list of [cp.customModels, cp.models]) {
    for (const entry of list ?? []) {
      if (typeof entry === "string") {
        if (entry) ids.add(entry)
        continue
      }
      const id = (entry as { id?: string } | null)?.id
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function collectOptions(
  providerSettings: Record<string, UserProviderSettings> | undefined,
  customProviders: CustomProviderSettings[] | undefined
): ModelOption[] {
  const out: ModelOption[] = []
  // Anthropic is always considered even without a providerSettings entry:
  // the sidecar runtime authenticates via API key or subscription OAuth and
  // needs no provider config. An explicit `enabled: false` entry opts out.
  const entries = Object.entries(providerSettings ?? {})
  if (!entries.some(([id]) => id === "anthropic")) {
    entries.unshift(["anthropic", { providerId: "anthropic" } as UserProviderSettings])
  }
  for (const [providerId, settings] of entries) {
    if (settings.enabled === false) continue
    const allowed = new Set<string>(settings.enabledModels ?? [])
    if (settings.defaultModel) allowed.add(settings.defaultModel)
    for (const m of settings.discoveredModels ?? []) {
      if (m?.id) allowed.add(m.id)
    }
    // OpenRouter's live list lives in the synced catalog, not `discoveredModels`.
    if (providerId === "openrouter") {
      for (const m of getCachedOpenRouterCatalogModels()) {
        if (m?.id) allowed.add(m.id)
      }
    }
    // Nothing configured at all → curated built-in catalog, never an empty group.
    const modelIds = allowed.size > 0 ? [...allowed] : catalogModelIds(providerId)
    for (const modelId of modelIds) {
      out.push({ providerId, providerName: providerId, modelId })
    }
  }
  for (const cp of customProviders ?? []) {
    if (cp.enabled === false) continue
    for (const modelId of customProviderModelIds(cp)) {
      out.push({ providerId: cp.id, providerName: cp.name ?? cp.id, modelId })
    }
  }
  return out
}

export function groupByProvider(options: ModelOption[]): ModelOptionGroup[] {
  const groups = new Map<string, { providerName: string; models: string[] }>()
  for (const opt of options) {
    const existing = groups.get(opt.providerId)
    if (existing) {
      if (!existing.models.includes(opt.modelId)) existing.models.push(opt.modelId)
    } else {
      groups.set(opt.providerId, { providerName: opt.providerName, models: [opt.modelId] })
    }
  }
  return Array.from(groups.entries()).map(([providerId, v]) => ({
    providerId,
    providerName: v.providerName,
    models: v.models,
  }))
}
