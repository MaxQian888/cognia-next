"use client"

// Theme + color preset selection. Replaces the original 4-control panel:
// the `mode` / `fontScale` / `language` controls move to typography-tab,
// `reduceMotion` stays there, and this tab owns the visual side
// (light/dark + 8 color presets) along with a live preview swatch grid.

import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useSettingsStore } from "@/stores/settings"
import type { AppTheme } from "@/lib/claude/types"
import type { ColorThemePreset } from "@/types/plugin/plugin-extended"
import { COLOR_PRESETS } from "@/lib/themes"
import { cn } from "@/lib/utils"

const PRESET_SWATCHES: Record<ColorThemePreset, { light: string; dark: string }> = {
  default: { light: "#3b82f6", dark: "#60a5fa" },
  ocean: { light: "#0284c7", dark: "#38bdf8" },
  forest: { light: "#16a34a", dark: "#4ade80" },
  sunset: { light: "#ea580c", dark: "#fb923c" },
  lavender: { light: "#7c3aed", dark: "#a78bfa" },
  rose: { light: "#e11d48", dark: "#fb7185" },
  slate: { light: "#475569", dark: "#94a3b8" },
  amber: { light: "#d97706", dark: "#fbbf24" },
}

export function ThemeTab() {
  const t = useTranslations("settings.appearance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const setActiveCustom = useSettingsStore((s) => s.setActiveCustomTheme)
  const { setTheme } = useTheme()
  const theme: AppTheme = settings?.theme ?? "system"
  const colorTheme: ColorThemePreset = settings?.colorTheme ?? "default"
  const activeCustomThemeId = settings?.activeCustomThemeId ?? null

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs">{t("themeLabel")}</Label>
        <RadioGroup
          value={theme}
          onValueChange={(v) => {
            const next = v as AppTheme
            setTheme(next)
            void save({ theme: next })
          }}
          className="flex flex-wrap gap-4"
        >
          {(["light", "dark", "system"] as AppTheme[]).map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value={opt} id={`theme-${opt}`} />
              {t(`theme.${opt}`)}
            </label>
          ))}
        </RadioGroup>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("colorPresetLabel")}</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {COLOR_PRESETS.map((preset) => {
            const swatches = PRESET_SWATCHES[preset]
            const active = colorTheme === preset && !activeCustomThemeId
            return (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  // Activating a preset clears the active custom theme — they're
                  // mutually exclusive in `resolveActiveThemeColors`.
                  if (activeCustomThemeId) void setActiveCustom(null)
                  void save({ colorTheme: preset })
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border-2 px-2 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary" : "border-border hover:border-foreground/30"
                )}
                aria-pressed={active}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="size-3 rounded-full" style={{ background: swatches.light }} />
                  <span className="size-3 rounded-full" style={{ background: swatches.dark }} />
                </span>
                <span className="truncate">{t(`colorPresets.${preset}`)}</span>
              </button>
            )
          })}
        </div>
        {activeCustomThemeId && (
          <p className="text-[11px] text-muted-foreground">
            {t("customTheme.activateButton")} → {t("customTheme.deactivateButton")}
          </p>
        )}
      </div>
    </div>
  )
}
