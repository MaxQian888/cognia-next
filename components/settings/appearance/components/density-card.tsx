"use client"

// Density card — global level + optional per-surface overrides. Reads/writes
// `settings.density`. Plays well with the `DensityApplier` (which writes the
// resulting `data-density` + per-surface attributes onto `<html>`).

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_DENSITY, type DensityLevel, type DensitySettings } from "@/types/appearance"

const LEVELS: { value: DensityLevel; labelKey: string }[] = [
  { value: "compact", labelKey: "density.compact" },
  { value: "comfortable", labelKey: "density.comfortable" },
  { value: "spacious", labelKey: "density.spacious" },
]

const SURFACES: { key: "chat" | "table" | "sidebar"; labelKey: string }[] = [
  { key: "chat", labelKey: "density.surface.chat" },
  { key: "table", labelKey: "density.surface.table" },
  { key: "sidebar", labelKey: "density.surface.sidebar" },
]

const INHERIT = "__inherit"

export function DensityCard() {
  const t = useTranslations("settings.appearance.layoutType")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const density: DensitySettings = { ...DEFAULT_DENSITY, ...(settings?.density ?? {}) }

  function update(patch: Partial<DensitySettings>) {
    void save({ density: { ...density, ...patch } })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">{t("density.globalLabel")}</Label>
        <Select
          value={density.global}
          onValueChange={(value) => update({ global: value as DensityLevel })}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("density.globalHint")}</p>
      </div>

      <div className="space-y-2 rounded border p-3">
        <Label className="text-xs">{t("density.overrideLabel")}</Label>
        <p className="text-[11px] text-muted-foreground">{t("density.overrideHint")}</p>
        <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
          {SURFACES.map((surface) => {
            const current = density[surface.key]
            return (
              <div key={surface.key} className="space-y-1">
                <Label className="text-[11px] uppercase text-muted-foreground">
                  {t(surface.labelKey)}
                </Label>
                <Select
                  value={current ?? INHERIT}
                  onValueChange={(value) => {
                    if (value === INHERIT) {
                      const next: DensitySettings = { ...density }
                      delete next[surface.key]
                      void save({ density: next })
                    } else {
                      update({ [surface.key]: value as DensityLevel })
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>{t("density.inherit")}</SelectItem>
                    {LEVELS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
