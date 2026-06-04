/**
 * Pure provider-settings → flat model list used by the composer model picker
 * and the eval run-config target picker. Extracted from
 * `components/chat/composer/model-picker.tsx` unchanged.
 */

import { PROVIDERS } from "@/types/provider/provider"
import type { UserProviderSettings, CustomProviderSettings } from "@/types/provider/provider"

export interface ModelOption {
  providerId: string
  providerName: string
  modelId: string
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
    const modelIds = allowed.size > 0 ? [...allowed] : catalogModelIds(providerId)
    for (const modelId of modelIds) {
      out.push({ providerId, providerName: providerId, modelId })
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
      })
    }
  }
  return out
}
