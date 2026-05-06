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
import type { ColorThemePreset, CustomTheme } from "@/types/plugin/plugin-extended"
import { COLOR_PRESETS } from "@/lib/themes"
import { BUILT_IN_VSCODE_THEMES } from "@/lib/appearance/built-in-vscode-themes"
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
  const createCustomTheme = useSettingsStore((s) => s.createCustomTheme)
  const { setTheme } = useTheme()
  const theme: AppTheme = settings?.theme ?? "system"
  const colorTheme: ColorThemePreset = settings?.colorTheme ?? "default"
  const activeCustomThemeId = settings?.activeCustomThemeId ?? null
  const customThemes = settings?.customThemes ?? []
  const importedRecords = settings?.importedVscodeThemes ?? []

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

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("vscode.legend")}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {BUILT_IN_VSCODE_THEMES.map((preset) => {
            const swatchVariant = preset.baseVariant ?? "dark"
            const swatchSet = preset.tokens?.[swatchVariant]
            const active =
              activeCustomThemeId != null &&
              customThemes.some((ct) => ct.id === activeCustomThemeId && ct.name === preset.name)
            return (
              <button
                key={preset.name}
                type="button"
                className={cn(
                  "rounded border p-2 text-left transition",
                  "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "border-primary bg-primary/5"
                )}
                onClick={() => {
                  if (active) {
                    setActiveCustom(null)
                    return
                  }
                  const id = createCustomTheme(preset as Omit<CustomTheme, "id">)
                  setActiveCustom(id)
                }}
              >
                <div className="flex gap-1">
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: swatchSet?.background }}
                    aria-hidden
                  />
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: swatchSet?.primary }}
                    aria-hidden
                  />
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: swatchSet?.accent }}
                    aria-hidden
                  />
                </div>
                <div className="mt-1 text-xs font-medium">
                  {preset.name}
                  {active && (
                    <span className="ml-1 text-[10px] text-primary">{t("vscode.activeLabel")}</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {t(`vscode.variant.${swatchVariant}`)}
                </div>
              </button>
            )
          })}
          {/* Imported themes — each maps to a CustomTheme row. */}
          {importedRecords.map((record) => {
            const ct = customThemes.find((c) => c.id === record.customThemeId)
            if (!ct) return null
            const variant = ct.baseVariant ?? (ct.isDark ? "dark" : "light")
            const tokens = ct.tokens?.[variant]
            const isActive = record.customThemeId === activeCustomThemeId
            return (
              <button
                key={record.customThemeId}
                type="button"
                className={cn(
                  "rounded border p-2 text-left transition",
                  "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive && "border-primary bg-primary/5"
                )}
                onClick={() => {
                  if (isActive) {
                    setActiveCustom(null)
                  } else {
                    setActiveCustom(record.customThemeId)
                  }
                }}
              >
                <div className="flex gap-1">
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: tokens?.background }}
                    aria-hidden
                  />
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: tokens?.primary }}
                    aria-hidden
                  />
                  <span
                    className="h-4 w-4 rounded"
                    style={{ background: tokens?.accent }}
                    aria-hidden
                  />
                </div>
                <div className="mt-1 text-xs font-medium">
                  {ct.name}
                  {isActive && (
                    <span className="ml-1 text-[10px] text-primary">{t("vscode.activeLabel")}</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {t(`vscode.variant.${variant}`)}
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
