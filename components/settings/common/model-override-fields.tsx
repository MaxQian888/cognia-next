"use client"

// Shared provider + model override fields for a background "utility model"
// config (UtilityModelConfig). Extracted from conversation-section.tsx so the
// conversation-title, timeline-label, and pet-speak configs present the same
// UI. Provider is a select of the user's configured providers (or "use chat
// default"); the model is a select of that provider's models — kept in sync so
// the pair can never drift (switching provider drops a model the new provider
// can't serve). The model list follows the *effective* provider: the explicit
// override when set, otherwise the app default (see
// `lib/ai/generation/utility-client.ts` for the resolution order).

import { useMemo } from "react"
import { useSettingsStore } from "@/stores/settings"
import type { UtilityModelConfig } from "@cognia/agent-config-types"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { collectModelOptions, type ModelOption } from "@/lib/ai/model-options"

const DEFAULT_PROVIDER_VALUE = "__default__"
const DEFAULT_MODEL_VALUE = "__default__"
// Terminal fallback of the utility-model provider resolution chain (see
// `buildUtilityLlmClient`): mirror it so the model list is never empty when
// neither an override nor an app default is set.
const FALLBACK_PROVIDER = "anthropic"

export interface ProviderOption {
  id: string
  name: string
}

/** The user's configured providers (built-in entries + custom), for the select. */
export function useUtilityProviderOptions(): ProviderOption[] {
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  return useMemo<ProviderOption[]>(() => {
    const map = new Map<string, ProviderOption>()
    for (const id of Object.keys(providerSettings ?? {})) {
      map.set(id, { id, name: id })
    }
    for (const p of customProviders ?? []) {
      const cp = p as { id: string; name?: string }
      map.set(cp.id, { id: cp.id, name: cp.name ?? cp.id })
    }
    return [...map.values()]
  }, [providerSettings, customProviders])
}

/**
 * All selectable provider+model pairs from the user's settings, sharing the
 * exact source the composer model picker uses (`collectModelOptions`). Consumed
 * by {@link ModelOverrideFields} to populate the model select for the selected
 * provider, so the utility-model dropdown offers the same models as the chat
 * composer.
 */
export function useUtilityModelOptions(): ModelOption[] {
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  return useMemo(
    () => collectModelOptions(providerSettings, customProviders),
    [providerSettings, customProviders]
  )
}

export function ModelOverrideFields({
  value,
  providers,
  onChange,
  labels,
}: {
  value: UtilityModelConfig | undefined
  providers: ProviderOption[]
  onChange: (patch: Partial<UtilityModelConfig>) => void
  labels: { provider: string; model: string; useDefault: string }
}) {
  const selectedProvider = value?.providerOverride
  const selectedModel = value?.model
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const allModelOptions = useUtilityModelOptions()

  // Provider whose models the select offers: the explicit override, else the
  // app default the utility client resolves to, else anthropic — so the list
  // matches what an un-overridden model would actually run against.
  const effectiveProvider = selectedProvider ?? defaultProvider ?? FALLBACK_PROVIDER

  // Models servable by the effective provider — same source as the composer
  // picker. A stored `model` that isn't in the catalog (e.g. a legacy free-text
  // value, or a model the user later removed from their whitelist) is kept as an
  // extra option so moving to a select never silently drops it.
  const modelOptions = useMemo<ModelOption[]>(() => {
    const forProvider = allModelOptions.filter((o) => o.providerId === effectiveProvider)
    if (selectedModel && !forProvider.some((o) => o.modelId === selectedModel)) {
      forProvider.push({
        providerId: effectiveProvider,
        providerName: effectiveProvider,
        modelId: selectedModel,
        modelName: selectedModel,
      })
    }
    return forProvider
  }, [allModelOptions, effectiveProvider, selectedModel])

  // Switching the provider keeps the (provider, model) pair coherent: drop the
  // model unless the new effective provider can still serve it. This is the
  // "state unification" guard — a model from provider A never lingers after a
  // switch to provider B (which would send A's model id to B's endpoint).
  const handleProviderChange = (next: string) => {
    const nextProvider = next === DEFAULT_PROVIDER_VALUE ? undefined : next
    const nextEffective = nextProvider ?? defaultProvider ?? FALLBACK_PROVIDER
    const stillServable =
      !selectedModel ||
      allModelOptions.some((o) => o.providerId === nextEffective && o.modelId === selectedModel)
    onChange({
      providerOverride: nextProvider,
      ...(stillServable ? {} : { model: undefined }),
    })
  }

  const handleModelChange = (next: string) => {
    onChange({ model: next === DEFAULT_MODEL_VALUE ? undefined : next })
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label>{labels.provider}</Label>
        <Select
          value={selectedProvider || DEFAULT_PROVIDER_VALUE}
          onValueChange={handleProviderChange}
        >
          <SelectTrigger aria-label={labels.provider}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_PROVIDER_VALUE}>{labels.useDefault}</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{labels.model}</Label>
        <Select value={selectedModel || DEFAULT_MODEL_VALUE} onValueChange={handleModelChange}>
          <SelectTrigger aria-label={labels.model}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL_VALUE}>{labels.useDefault}</SelectItem>
            {modelOptions.map((o) => (
              <SelectItem key={o.modelId} value={o.modelId}>
                {o.modelName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export default ModelOverrideFields
