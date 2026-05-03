"use client"

// Font scale, language and reduce-motion toggles. The original
// appearance-section had these inline; we keep the same controls here so
// users can find them without learning the new layout.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import type { AppFontScale, AppLanguage } from "@/lib/claude/types"
import { responsiveSelectClass } from "@/lib/utils"

const FONT_SCALES: { value: AppFontScale; label: string }[] = [
  { value: "xs", label: "XS · 14px" },
  { value: "sm", label: "S · 15px" },
  { value: "md", label: "M · 16px" },
  { value: "lg", label: "L · 17px" },
  { value: "xl", label: "XL · 18px" },
]

const LANGUAGES: { value: AppLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
]

export function TypographyTab() {
  const t = useTranslations("settings.appearance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const fontScale: AppFontScale = settings?.fontScale ?? "md"
  const language: AppLanguage = settings?.language ?? "en"
  const reduceMotion = Boolean(settings?.reduceMotion)

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs">{t("fontScaleLabel")}</Label>
        <Select
          value={fontScale}
          onValueChange={(v) => {
            void save({ fontScale: v as AppFontScale })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
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
          <SelectTrigger className={responsiveSelectClass}>
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
          aria-label={t("reduceMotionLabel")}
        />
      </div>
    </div>
  )
}
