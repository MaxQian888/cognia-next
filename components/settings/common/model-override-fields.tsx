"use client"

// Shared provider + model override fields for a background "utility model"
// config (UtilityModelConfig). Extracted from conversation-section.tsx so the
// conversation-title, timeline-label, and pet-speak configs present the same
// UI. Provider is a select of the user's configured providers (or "use chat
// default"); model is free text since model ids vary per provider.

import { useMemo } from "react"
import { useSettingsStore } from "@/stores/settings"
import type { UtilityModelConfig } from "@cognia/agent-config-types"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const DEFAULT_PROVIDER_VALUE = "__default__"

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
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label>{labels.provider}</Label>
        <Select
          value={value?.providerOverride || DEFAULT_PROVIDER_VALUE}
          onValueChange={(v) =>
            onChange({ providerOverride: v === DEFAULT_PROVIDER_VALUE ? undefined : v })
          }
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
        <Input
          value={value?.model ?? ""}
          placeholder={labels.useDefault}
          aria-label={labels.model}
          onChange={(e) => onChange({ model: e.target.value || undefined })}
        />
      </div>
    </div>
  )
}

export default ModelOverrideFields
