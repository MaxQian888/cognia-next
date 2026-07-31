/**
 * Shared provider+model option source for pickers.
 *
 * Extracted from `components/settings/agent-runtime/parts/default-model-picker.tsx`
 * so the routing alias editor's provider:model combobox and the default-model
 * picker present the exact same option universe (enabled providers, discovered
 * models, curated built-in catalog fallback, custom providers).
 */

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
    // Nothing configured at all → curated built-in catalog, never an empty group.
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
