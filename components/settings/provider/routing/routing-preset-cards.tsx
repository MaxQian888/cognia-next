"use client"

// One-click preset activation cards (Budget / Performance / Reliability) +
// the revert affordance once a preset is active.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PiggyBank, Shield, Undo2, Zap } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BUILT_IN_PRESETS } from "@/lib/ai/routing/built-in-presets"
import { RoutingPresetPreviewDialog } from "./routing-preset-preview-dialog"
import type { RoutingPreset } from "@/types/provider/routing-presets"

const PRESET_ICONS: Record<string, React.ReactNode> = {
  budget: <PiggyBank className="h-4 w-4" />,
  performance: <Zap className="h-4 w-4" />,
  reliability: <Shield className="h-4 w-4" />,
}

export function RoutingPresetCards() {
  const t = useTranslations("providers.routingView")
  const routingPresets = useSettingsStore((s) => s.settings?.routingPresets)
  const revertRoutingPreset = useSettingsStore((s) => s.revertRoutingPreset)

  const [previewPreset, setPreviewPreset] = useState<RoutingPreset | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  const activeId = routingPresets?.activePresetId ?? null
  const canRevert = Boolean(routingPresets?.preActivationSnapshot)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {BUILT_IN_PRESETS.map((preset) => {
          const isActive = activeId === preset.id
          return (
            <div
              key={preset.id}
              className="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
              data-testid={`preset-card-${preset.builtInId}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {PRESET_ICONS[preset.builtInId ?? ""] ?? null}
                </span>
                <p className="text-sm font-medium">{t(`preset.${preset.builtInId}.name`)}</p>
                {isActive ? (
                  <Badge className="ml-auto text-[10px]">{t("presetActive")}</Badge>
                ) : null}
              </div>
              <p className="flex-1 text-[11px] text-muted-foreground">
                {t(`preset.${preset.builtInId}.desc`)}
              </p>
              <Button
                variant={isActive ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setPreviewPreset(preset)
                  setPreviewOpen(true)
                }}
              >
                {t("presetPreview")}
              </Button>
            </div>
          )
        })}
      </div>

      {canRevert ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void revertRoutingPreset()}
        >
          <Undo2 className="mr-1 h-3 w-3" />
          {t("revert")}
        </Button>
      ) : null}

      <RoutingPresetPreviewDialog
        preset={previewPreset}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </div>
  )
}

export default RoutingPresetCards
