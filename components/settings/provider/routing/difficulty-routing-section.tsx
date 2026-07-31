"use client"

// Opt-in heuristic difficulty routing (RouteLLM-lite): a registered
// routing strategy ("difficulty") that scores the prompt 0–1 and picks
// the strong model at/above the threshold, the weak one below it.
// Persisted on AppSettings.difficultyRouting. Default OFF — the strategy
// only takes effect when chosen as the routing strategy (or a
// per-request override) AND a model pair is configured here.

import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_DIFFICULTY_ROUTING,
  type DifficultyRoutingSettings,
} from "@/types/routing/tool-route"

function ModelPairField({
  idPrefix,
  label,
  value,
  disabled,
  onChange,
}: {
  idPrefix: string
  label: string
  value?: { providerId: string; modelId: string }
  disabled: boolean
  onChange: (next: { providerId: string; modelId: string } | undefined) => void
}) {
  const t = useTranslations("providers.routingView.difficulty")
  const update = (key: "providerId" | "modelId", raw: string) => {
    const next = { providerId: value?.providerId ?? "", modelId: value?.modelId ?? "", [key]: raw }
    if (!next.providerId.trim() && !next.modelId.trim()) {
      onChange(undefined)
    } else {
      onChange(next)
    }
  }
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground" htmlFor={`${idPrefix}-provider`}>
            {t("providerId")}
          </Label>
          <Input
            id={`${idPrefix}-provider`}
            value={value?.providerId ?? ""}
            onChange={(e) => update("providerId", e.target.value)}
            className="h-8 text-xs"
            disabled={disabled}
            placeholder="openai"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground" htmlFor={`${idPrefix}-model`}>
            {t("modelId")}
          </Label>
          <Input
            id={`${idPrefix}-model`}
            value={value?.modelId ?? ""}
            onChange={(e) => update("modelId", e.target.value)}
            className="h-8 text-xs"
            disabled={disabled}
            placeholder="gpt-4o-mini"
          />
        </div>
      </div>
    </fieldset>
  )
}

export function DifficultyRoutingSection() {
  const t = useTranslations("providers.routingView.difficulty")
  const settings =
    useSettingsStore((s) => s.settings?.difficultyRouting) ?? DEFAULT_DIFFICULTY_ROUTING
  const save = useSettingsStore((s) => s.save)

  const patch = (partial: Partial<DifficultyRoutingSettings>) =>
    void save({ difficultyRouting: { ...settings, ...partial } })

  return (
    <div className="space-y-4" data-testid="difficulty-routing-section">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="difficulty-routing-enabled" className="text-xs">
          {t("enabled")}
        </Label>
        <Switch
          id="difficulty-routing-enabled"
          checked={settings.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked === true })}
        />
      </div>

      <ModelPairField
        idPrefix="difficulty-weak"
        label={t("weakModel")}
        value={settings.weakModel}
        disabled={!settings.enabled}
        onChange={(weakModel) => patch({ weakModel })}
      />
      <ModelPairField
        idPrefix="difficulty-strong"
        label={t("strongModel")}
        value={settings.strongModel}
        disabled={!settings.enabled}
        onChange={(strongModel) => patch({ strongModel })}
      />

      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="difficulty-threshold">
          {t("threshold")}
        </Label>
        <Input
          id="difficulty-threshold"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={settings.threshold}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= 0 && n <= 1) patch({ threshold: n })
          }}
          className="h-8 text-xs"
          disabled={!settings.enabled}
        />
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      </div>
    </div>
  )
}
