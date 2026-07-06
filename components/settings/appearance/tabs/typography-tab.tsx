"use client"

// Pure typography: font scale, interface language, the sans/mono/serif family
// pickers, and line-height / letter-spacing fine-tuning. Spacing (density),
// shape (corner radius) and the display-density modes moved to the Layout tab;
// motion controls live in the Accessibility tab. Keeping this tab focused on
// type makes its label honest and shortens the scroll.

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
import type { AppFontScale, AppLanguage } from "@/lib/claude/types"
import { responsiveSelectClass } from "@/lib/utils"
import { DEFAULT_TYPOGRAPHY_EXT, type TypographyExtSettings } from "@/types/appearance"
import { FontFamilyPicker } from "../components/font-family-picker"
import { SettingSliderRow } from "../components/setting-slider-row"

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
  const tLayout = useTranslations("settings.appearance.layoutType")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const fontScale: AppFontScale = settings?.fontScale ?? "md"
  const language: AppLanguage = settings?.language ?? "en"
  const typographyExt: TypographyExtSettings = {
    ...DEFAULT_TYPOGRAPHY_EXT,
    ...(settings?.typographyExt ?? {}),
  }

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

      {/* Font family / mono / serif pickers */}
      <div className="space-y-3 border-t pt-4">
        <Label className="text-sm">{tLayout("font.sectionLabel")}</Label>
        <FontFamilyPicker
          labelKey="font.sansLabel"
          value={typographyExt.fontFamily}
          onChange={(next) => void save({ typographyExt: { ...typographyExt, fontFamily: next } })}
          hintKey="font.sansHint"
        />
        <FontFamilyPicker
          labelKey="font.monoLabel"
          value={typographyExt.monoFamily}
          onChange={(next) => void save({ typographyExt: { ...typographyExt, monoFamily: next } })}
          monoOnly
        />
        <FontFamilyPicker
          labelKey="font.serifLabel"
          value={typographyExt.serifFamily}
          onChange={(next) => void save({ typographyExt: { ...typographyExt, serifFamily: next } })}
        />
      </div>

      {/* Line-height + letter-spacing fine-tuning */}
      <div className="space-y-4 border-t pt-4">
        <Label className="text-sm">{tLayout("fine.sectionLabel")}</Label>
        <SettingSliderRow
          label={tLayout("fine.lineHeight")}
          ariaLabel={tLayout("fine.lineHeight")}
          value={typographyExt.lineHeightScale}
          defaultValue={DEFAULT_TYPOGRAPHY_EXT.lineHeightScale}
          min={0.875}
          max={1.25}
          step={0.005}
          format={(v) => v.toFixed(3)}
          onChange={(next) =>
            void save({ typographyExt: { ...typographyExt, lineHeightScale: next } })
          }
        />
        <SettingSliderRow
          label={tLayout("fine.letterSpacing")}
          ariaLabel={tLayout("fine.letterSpacing")}
          value={typographyExt.letterSpacingEm}
          defaultValue={DEFAULT_TYPOGRAPHY_EXT.letterSpacingEm}
          min={-0.02}
          max={0.02}
          step={0.001}
          format={(v) => `${v.toFixed(3)}em`}
          onChange={(next) =>
            void save({ typographyExt: { ...typographyExt, letterSpacingEm: next } })
          }
        />
      </div>
    </div>
  )
}
