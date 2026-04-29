"use client"

import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings-store"
import type { AppFontScale, AppLanguage, AppTheme } from "@/lib/claude/types"
import { PaletteIcon } from "lucide-react"

const FONT_SCALES: { value: AppFontScale; label: string }[] = [
  { value: "xs", label: "XS · 14px" },
  { value: "sm", label: "S · 15px" },
  { value: "md", label: "M · 16px (default)" },
  { value: "lg", label: "L · 17px" },
  { value: "xl", label: "XL · 18px" },
]

const LANGUAGES: { value: AppLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
]

export function AppearanceSection() {
  const t = useTranslations("settings.appearance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const { setTheme } = useTheme()

  const theme: AppTheme = settings?.theme ?? "system"
  const fontScale: AppFontScale = settings?.fontScale ?? "md"
  const language: AppLanguage = settings?.language ?? "en"
  const reduceMotion = Boolean(settings?.reduceMotion)

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <PaletteIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("themeLabel")}</Label>
        <RadioGroup
          value={theme}
          onValueChange={(v) => {
            const next = v as AppTheme
            setTheme(next)
            void save({ theme: next })
          }}
          className="flex gap-4"
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
        <Label className="text-xs">{t("fontScaleLabel")}</Label>
        <Select
          value={fontScale}
          onValueChange={(v) => {
            void save({ fontScale: v as AppFontScale })
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SCALES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("fontScaleHint")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("languageLabel")}</Label>
        <Select
          value={language}
          onValueChange={(v) => {
            void save({ language: v as AppLanguage })
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("reduceMotionLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("reduceMotionHint")}</p>
        </div>
        <Switch
          checked={reduceMotion}
          onCheckedChange={(checked) => {
            void save({ reduceMotion: checked })
          }}
        />
      </div>
    </div>
  )
}
