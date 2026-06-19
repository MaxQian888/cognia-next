"use client"

// A11y tab — surfaces WCAG target, contrast-enforcement mode, high-contrast
// preset, colorblind palette, motion speed, and a reduce-motion guard.
//
// Wiring summary (engine layer was built in P3 / P2):
//   - `settings.a11y.{wcagTarget,enforcement,highContrast,colorblindMode}`
//     → consumed by `CustomThemeApplier` (high-contrast / colorblind layers)
//     and by `auditTokens / autoFixViolations` (custom-theme tab + audit
//     pipeline).
//   - `settings.motion.{speed,reduce}` → consumed by `MotionApplier`. Legacy
//     `settings.reduceMotion` toggle stays in typography-tab for backward
//     compat; this tab provides the canonical new control.

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
import { responsiveSelectClass } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_A11Y,
  DEFAULT_MOTION,
  type ColorblindMode,
  type HighContrastMode,
  type MotionSpeed,
  type WcagEnforcement,
  type WcagTarget,
} from "@/types/appearance"

const WCAG_TARGETS: { value: WcagTarget; labelKey: string }[] = [
  { value: "off", labelKey: "wcag.target.off" },
  { value: "AA", labelKey: "wcag.target.AA" },
  { value: "AAA", labelKey: "wcag.target.AAA" },
]

const ENFORCEMENTS: { value: WcagEnforcement; labelKey: string }[] = [
  { value: "warn", labelKey: "wcag.enforcement.warn" },
  { value: "warn+fix", labelKey: "wcag.enforcement.warnFix" },
]

const HIGH_CONTRASTS: { value: HighContrastMode; labelKey: string }[] = [
  { value: "off", labelKey: "highContrast.off" },
  { value: "light", labelKey: "highContrast.light" },
  { value: "dark", labelKey: "highContrast.dark" },
]

const COLORBLIND: { value: ColorblindMode; labelKey: string }[] = [
  { value: "off", labelKey: "colorblind.off" },
  { value: "deuter", labelKey: "colorblind.deuter" },
  { value: "protan", labelKey: "colorblind.protan" },
  { value: "tritan", labelKey: "colorblind.tritan" },
]

const MOTION_SPEEDS: { value: MotionSpeed; labelKey: string }[] = [
  { value: 0.5, labelKey: "motion.speed.slow" },
  { value: 1, labelKey: "motion.speed.normal" },
  { value: 1.5, labelKey: "motion.speed.fast" },
]

export function A11yTab() {
  const t = useTranslations("settings.appearance.a11y")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const a11y = { ...DEFAULT_A11Y, ...(settings?.a11y ?? {}) }
  const motion = { ...DEFAULT_MOTION, ...(settings?.motion ?? {}) }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs">{t("wcag.targetLabel")}</Label>
        <Select
          value={a11y.wcagTarget}
          onValueChange={(value) => {
            void save({ a11y: { ...a11y, wcagTarget: value as WcagTarget } })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WCAG_TARGETS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("wcag.targetHint")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("wcag.enforcementLabel")}</Label>
        <Select
          value={a11y.enforcement}
          onValueChange={(value) => {
            void save({ a11y: { ...a11y, enforcement: value as WcagEnforcement } })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENFORCEMENTS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("wcag.enforcementHint")}</p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label className="text-xs">{t("highContrast.label")}</Label>
        <Select
          value={a11y.highContrast}
          onValueChange={(value) => {
            void save({ a11y: { ...a11y, highContrast: value as HighContrastMode } })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HIGH_CONTRASTS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("highContrast.hint")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("colorblind.label")}</Label>
        <Select
          value={a11y.colorblindMode}
          onValueChange={(value) => {
            void save({ a11y: { ...a11y, colorblindMode: value as ColorblindMode } })
          }}
        >
          <SelectTrigger className={responsiveSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLORBLIND.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("colorblind.hint")}</p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label className="text-xs">{t("motion.speedLabel")}</Label>
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
            {MOTION_SPEEDS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("motion.reduceLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("motion.reduceHint")}</p>
        </div>
        <Switch
          checked={motion.reduce}
          onCheckedChange={(checked) => {
            void save({ motion: { ...motion, reduce: checked } })
          }}
          aria-label={t("motion.reduceLabel")}
        />
      </div>
    </div>
  )
}
