"use client"

// Font scale, language, reduce-motion + (v47) font families, density,
// radius, motion-speed, and typography fine-tuning (line-height /
// letter-spacing). The original three controls live at the top of the tab
// so existing users don't have to learn a new layout; v47 additions are
// gathered under labelled subsections below.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import type { AppFontScale, AppLanguage } from "@/lib/claude/types"
import { responsiveSelectClass } from "@/lib/utils"
import {
  DEFAULT_MOTION,
  DEFAULT_RADIUS,
  DEFAULT_TYPOGRAPHY_EXT,
  type MotionSpeed,
  type RadiusSettings,
  type TypographyExtSettings,
} from "@/types/appearance"
import { DensityCard } from "../components/density-card"
import { AgentFlowCard } from "../components/agent-flow-card"
import { UsageDisplayCard } from "../components/usage-display-card"
import { FontFamilyPicker } from "../components/font-family-picker"

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

const MOTION_SPEED_OPTIONS: { value: MotionSpeed; key: string }[] = [
  { value: 0.5, key: "motion.speed.slow" },
  { value: 1, key: "motion.speed.normal" },
  { value: 1.5, key: "motion.speed.fast" },
]

export function TypographyTab() {
  const t = useTranslations("settings.appearance")
  const tLayout = useTranslations("settings.appearance.layoutType")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const fontScale: AppFontScale = settings?.fontScale ?? "md"
  const language: AppLanguage = settings?.language ?? "en"
  const reduceMotion = Boolean(settings?.reduceMotion)
  const typographyExt: TypographyExtSettings = {
    ...DEFAULT_TYPOGRAPHY_EXT,
    ...(settings?.typographyExt ?? {}),
  }
  const radius: RadiusSettings = { ...DEFAULT_RADIUS, ...(settings?.radius ?? {}) }
  const motion = { ...DEFAULT_MOTION, ...(settings?.motion ?? {}) }

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

      {/* v47 — font family / mono / serif pickers */}
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

      {/* v47 — line-height + letter-spacing sliders */}
      <div className="space-y-4 border-t pt-4">
        <Label className="text-sm">{tLayout("fine.sectionLabel")}</Label>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>{tLayout("fine.lineHeight")}</span>
            <span className="font-mono text-muted-foreground">
              {typographyExt.lineHeightScale.toFixed(3)}
            </span>
          </div>
          <Slider
            min={0.875}
            max={1.25}
            step={0.005}
            value={[typographyExt.lineHeightScale]}
            onValueChange={([next]) =>
              void save({
                typographyExt: { ...typographyExt, lineHeightScale: next },
              })
            }
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>{tLayout("fine.letterSpacing")}</span>
            <span className="font-mono text-muted-foreground">
              {typographyExt.letterSpacingEm.toFixed(3)}em
            </span>
          </div>
          <Slider
            min={-0.02}
            max={0.02}
            step={0.001}
            value={[typographyExt.letterSpacingEm]}
            onValueChange={([next]) =>
              void save({
                typographyExt: { ...typographyExt, letterSpacingEm: next },
              })
            }
          />
        </div>
      </div>

      {/* v47 — density */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("density.sectionLabel")}</Label>
        <DensityCard />
      </div>

      {/* Agent invocation-flow display mode */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("agentFlow.sectionLabel")}</Label>
        <AgentFlowCard />
      </div>

      {/* Usage / consumption statistics display mode */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("usageDisplay.sectionLabel")}</Label>
        <UsageDisplayCard />
      </div>

      {/* v47 — radius slider */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("radius.sectionLabel")}</Label>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>{tLayout("radius.label")}</span>
            <span className="font-mono text-muted-foreground">{radius.base.toFixed(3)}rem</span>
          </div>
          <Slider
            min={0}
            max={1.5}
            step={0.025}
            value={[radius.base]}
            onValueChange={([next]) => void save({ radius: { base: next } })}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{tLayout("radius.hint")}</p>
      </div>

      {/* v47 — motion speed (reduce-motion lives in a11y tab) */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("motion.sectionLabel")}</Label>
        <Select
          value={String(motion.speed)}
          onValueChange={(value) => {
            const speed = Number(value) as MotionSpeed
            void save({ motion: { ...motion, speed } })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MOTION_SPEED_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {tLayout(opt.key)}
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
