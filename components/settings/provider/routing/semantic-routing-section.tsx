"use client"

// Opt-in semantic tool routing (semantic-router analog): when more plugin
// tools than the activation threshold are exposed, prune the manifest to
// the top-K semantic matches for the prompt plus pinned tools. Persisted
// on AppSettings.semanticToolRouting; consumed in resolveSendOptions via
// lib/ai/routing/semantic-tool-router.ts. Default OFF.

import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_SEMANTIC_TOOL_ROUTING,
  type SemanticToolRoutingSettings,
} from "@/types/routing/tool-route"

export function SemanticRoutingSection() {
  const t = useTranslations("providers.routingView.semantic")
  const settings =
    useSettingsStore((s) => s.settings?.semanticToolRouting) ?? DEFAULT_SEMANTIC_TOOL_ROUTING
  const save = useSettingsStore((s) => s.save)

  const patch = (partial: Partial<SemanticToolRoutingSettings>) =>
    void save({ semanticToolRouting: { ...settings, ...partial } })

  const patchNumber =
    (key: "activationToolCount" | "topK", min: number) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = Number(e.target.value)
      if (Number.isInteger(n) && n >= min) patch({ [key]: n })
    }

  return (
    <div className="space-y-4" data-testid="semantic-routing-section">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="semantic-routing-enabled" className="text-xs">
          {t("enabled")}
        </Label>
        <Switch
          id="semantic-routing-enabled"
          checked={settings.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked === true })}
        />
      </div>

      {/* Three number fields at ~110px each on a phone; stack them instead. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="semantic-activation-count">
            {t("activationToolCount")}
          </Label>
          <Input
            id="semantic-activation-count"
            type="number"
            min={1}
            value={settings.activationToolCount}
            onChange={patchNumber("activationToolCount", 1)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="semantic-topk">
            {t("topK")}
          </Label>
          <Input
            id="semantic-topk"
            type="number"
            min={1}
            value={settings.topK}
            onChange={patchNumber("topK", 1)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="semantic-threshold">
            {t("threshold")}
          </Label>
          <Input
            id="semantic-threshold"
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
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="semantic-pinned">
          {t("pinnedTools")}
        </Label>
        <Input
          id="semantic-pinned"
          value={settings.pinnedTools.join(", ")}
          placeholder={t("pinnedToolsPlaceholder")}
          onChange={(e) =>
            patch({
              pinnedTools: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className="h-8 text-xs"
          disabled={!settings.enabled}
        />
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      </div>
    </div>
  )
}
