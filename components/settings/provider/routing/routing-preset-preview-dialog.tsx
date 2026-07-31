"use client"

// Preview-before-apply dialog for a built-in routing preset: shows the
// adapted alias chains (only providers enabled right now), a merge/overwrite
// choice (merge default), and explains that activation is revertible.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { adaptPresetToEnabledProviders } from "@cognia/provider-routing/built-in-presets"
import { FallbackChainView } from "./fallback-chain-view"
import type { BuiltInPresetId, RoutingPreset } from "@cognia/provider-types/routing-presets"

interface RoutingPresetPreviewDialogProps {
  preset: RoutingPreset | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RoutingPresetPreviewDialog({
  preset,
  open,
  onOpenChange,
}: RoutingPresetPreviewDialogProps) {
  const t = useTranslations("providers.routingView")
  const settings = useSettingsStore((s) => s.settings)
  const activateRoutingPreset = useSettingsStore((s) => s.activateRoutingPreset)
  const [mode, setMode] = useState<"merge" | "overwrite">("merge")

  const adapted = useMemo(() => {
    if (!preset) return null
    const enabledIds = new Set<string>()
    for (const [id, s] of Object.entries(settings?.providerSettings ?? {})) {
      if (s.enabled !== false) enabledIds.add(id)
    }
    if (settings?.providerSettings?.["anthropic"]?.enabled !== false) enabledIds.add("anthropic")
    for (const cp of settings?.customProviders ?? []) {
      if (cp.enabled !== false) enabledIds.add(cp.id)
    }
    return adaptPresetToEnabledProviders(preset, enabledIds)
  }, [preset, settings?.providerSettings, settings?.customProviders])

  const handleApply = async () => {
    if (!preset?.builtInId) return
    await activateRoutingPreset(preset.builtInId as BuiltInPresetId, mode)
    onOpenChange(false)
  }

  if (!preset) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("previewTitle", { name: t(`preset.${preset.builtInId}.name`) })}
          </DialogTitle>
          <DialogDescription>{t("previewDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="max-h-64 space-y-2.5 overflow-y-auto pr-1">
            {(adapted?.mappings ?? []).map((m) => (
              <div key={m.alias} className="space-y-1">
                <p className="font-mono text-xs font-medium">{m.alias}</p>
                <FallbackChainView entries={m.providers} />
              </div>
            ))}
            {(adapted?.mappings.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{t("previewEmpty")}</p>
            ) : null}
          </div>

          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "merge" | "overwrite")}
            className="gap-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="merge" id="preset-merge" className="mt-0.5" />
              <Label htmlFor="preset-merge" className="flex flex-col gap-0.5 text-xs">
                <span className="font-medium">{t("applyModeMerge")}</span>
                <span className="font-normal text-muted-foreground">{t("applyModeMergeDesc")}</span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="overwrite" id="preset-overwrite" className="mt-0.5" />
              <Label htmlFor="preset-overwrite" className="flex flex-col gap-0.5 text-xs">
                <span className="font-medium">{t("applyModeOverwrite")}</span>
                <span className="font-normal text-muted-foreground">
                  {t("applyModeOverwriteDesc")}
                </span>
              </Label>
            </div>
          </RadioGroup>

          <p className="text-[11px] text-muted-foreground">{t("revertNote")}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={(adapted?.mappings.length ?? 0) === 0}
            onClick={() => void handleApply()}
          >
            {t("confirmApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default RoutingPresetPreviewDialog
