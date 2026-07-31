"use client"

// Opt-in automatic tier routing. When enabled, the send path scores each
// non-alias prompt's difficulty (0–1, lexical heuristic) and rewrites the
// model to a tier alias (fast/balanced/powerful), which the existing routing
// engine then resolves. Persisted on AppSettings.autoRouting. Default OFF — a
// strict no-op until enabled AND matching aliases exist in the mapping list
// above. See `lib/routing/auto-tier.ts`.

import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { DEFAULT_AUTO_ROUTING, type AutoRoutingSettings } from "@/types/routing/tool-route"

export function AutoRoutingSection() {
  const t = useTranslations("providers.routingView.auto")
  const stored = useSettingsStore((s) => s.settings?.autoRouting)
  const settings: AutoRoutingSettings = {
    ...DEFAULT_AUTO_ROUTING,
    ...(stored ?? {}),
    dataPolicy: {
      ...DEFAULT_AUTO_ROUTING.dataPolicy,
      ...(stored?.dataPolicy ?? {}),
    },
    thresholds: {
      ...DEFAULT_AUTO_ROUTING.thresholds,
      ...(stored?.thresholds ?? {}),
    },
  }
  const save = useSettingsStore((s) => s.save)

  const patch = (partial: Partial<AutoRoutingSettings>) =>
    void save({ autoRouting: { ...settings, ...partial } })

  const setThreshold = (key: "balanced" | "powerful", raw: string) => {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      patch({ thresholds: { ...settings.thresholds, [key]: n } })
    }
  }

  return (
    <div className="space-y-4" data-testid="auto-routing-section">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="auto-routing-enabled" className="text-xs">
          {t("enabled")}
        </Label>
        <Switch
          id="auto-routing-enabled"
          checked={settings.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked === true })}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-default" className="text-xs">
            {t("defaultSelection")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("defaultSelectionHint")}</p>
        </div>
        <Switch
          id="auto-routing-default"
          checked={settings.defaultSelection === "auto"}
          onCheckedChange={(checked) =>
            patch({ defaultSelection: checked === true ? "auto" : "manual" })
          }
          disabled={!settings.enabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-local-only" className="text-xs">
            {t("localOnly")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("localOnlyHint")}</p>
        </div>
        <Switch
          id="auto-routing-local-only"
          checked={settings.dataPolicy.locality === "local-only"}
          onCheckedChange={(checked) =>
            patch({
              dataPolicy: {
                ...settings.dataPolicy,
                locality: checked === true ? "local-only" : "any",
              },
            })
          }
          disabled={!settings.enabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-shadow" className="text-xs">
            {t("shadowMode")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("shadowModeHint")}</p>
        </div>
        <Switch
          id="auto-routing-shadow"
          checked={settings.shadowMode}
          onCheckedChange={(checked) => patch({ shadowMode: checked === true })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-threshold-balanced">
            {t("thresholdBalanced")}
          </Label>
          <Input
            id="auto-threshold-balanced"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.thresholds.balanced}
            onChange={(e) => setThreshold("balanced", e.target.value)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-threshold-powerful">
            {t("thresholdPowerful")}
          </Label>
          <Input
            id="auto-threshold-powerful"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.thresholds.powerful}
            onChange={(e) => setThreshold("powerful", e.target.value)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("hint", { tiers: settings.candidateAliases.join(" → ") })}
      </p>
    </div>
  )
}
