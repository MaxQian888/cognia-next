"use client"

// A11y tab — surfaces WCAG target, contrast-enforcement mode, high-contrast
// preset, colorblind palette, motion speed, and a reduce-motion guard.
//
// Wiring summary (engine layer was built in P3 / P2):
//   - `settings.a11y.{wcagTarget,enforcement,highContrast,colorblindMode}`
//     → consumed by `CustomThemeApplier` (high-contrast / colorblind layers)
//     and by `auditTokens / autoFixViolations` (custom-theme tab + audit
//     pipeline).
//   - `settings.motion.{speed,reduce}` → consumed by `MotionApplier`. This tab
//     is now the single home for motion controls (they were removed from the
//     Typography tab). The reduce-motion toggle writes BOTH the canonical
//     `motion.reduce` and the legacy `settings.reduceMotion` boolean so the
//     desktop View menu, mobile preferences, and backup stay in agreement, and
//     it reads whichever source is authoritative (mirrors MotionApplier).
//
// The six controls are grouped into the three questions they answer — how
// strictly contrast is audited, what color layer sits on the theme, and how
// much the UI moves. Flat, they were six near-identical select blocks separated
// by unlabelled hairlines, and nothing said which ones belonged together.

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
  // Explicit `motion.reduce` wins; otherwise fall back to the legacy
  // `reduceMotion` baseline so a toggle set from the desktop menu is reflected.
  const reduceMotionChecked = settings?.motion?.reduce ?? Boolean(settings?.reduceMotion)

  return (
    <div className="space-y-4">
      <A11yGroup groupKey="contrast" data-testid="a11y-group-contrast">
        <A11ySelect
          label={t("wcag.targetLabel")}
          hint={t("wcag.targetHint")}
          value={a11y.wcagTarget}
          options={WCAG_TARGETS}
          getLabel={(key) => t(key)}
          onChange={(value) => void save({ a11y: { ...a11y, wcagTarget: value as WcagTarget } })}
        />
        <A11ySelect
          label={t("wcag.enforcementLabel")}
          hint={t("wcag.enforcementHint")}
          value={a11y.enforcement}
          options={ENFORCEMENTS}
          getLabel={(key) => t(key)}
          onChange={(value) =>
            void save({ a11y: { ...a11y, enforcement: value as WcagEnforcement } })
          }
        />
      </A11yGroup>

      <A11yGroup groupKey="vision" data-testid="a11y-group-vision">
        <A11ySelect
          label={t("highContrast.label")}
          hint={t("highContrast.hint")}
          value={a11y.highContrast}
          options={HIGH_CONTRASTS}
          getLabel={(key) => t(key)}
          onChange={(value) =>
            void save({ a11y: { ...a11y, highContrast: value as HighContrastMode } })
          }
        />
        <A11ySelect
          label={t("colorblind.label")}
          hint={t("colorblind.hint")}
          value={a11y.colorblindMode}
          options={COLORBLIND}
          getLabel={(key) => t(key)}
          onChange={(value) =>
            void save({ a11y: { ...a11y, colorblindMode: value as ColorblindMode } })
          }
        />
      </A11yGroup>

      <A11yGroup groupKey="motion" data-testid="a11y-group-motion">
        <A11ySelect
          label={t("motion.speedLabel")}
          value={String(motion.speed)}
          options={MOTION_SPEEDS.map((opt) => ({
            value: String(opt.value),
            labelKey: opt.labelKey,
          }))}
          getLabel={(key) => t(key)}
          // Reduced motion pins every duration to zero, so a speed multiplier
          // under it is a control that provably does nothing.
          disabled={reduceMotionChecked}
          hint={reduceMotionChecked ? t("motion.speedDisabledHint") : undefined}
          onChange={(value) =>
            void save({ motion: { ...motion, speed: Number(value) as MotionSpeed } })
          }
        />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-xs">{t("motion.reduceLabel")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("motion.reduceHint")}</p>
          </div>
          <Switch
            checked={reduceMotionChecked}
            onCheckedChange={(checked) => {
              // Keep the legacy boolean in lock-step with the canonical one.
              void save({ motion: { ...motion, reduce: checked }, reduceMotion: checked })
            }}
            aria-label={t("motion.reduceLabel")}
          />
        </div>
      </A11yGroup>
    </div>
  )
}

/**
 * One titled card of related controls. Two-up once the detail pane can afford
 * it — sized off `@…/appearance-pane` rather than the viewport, since the pane
 * is the window minus a 320px nav.
 */
function A11yGroup({
  groupKey,
  children,
  "data-testid": testId,
}: {
  groupKey: "contrast" | "vision" | "motion"
  children: React.ReactNode
  "data-testid": string
}) {
  const t = useTranslations("settings.appearance.a11y.groups")
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid={testId}>
      <div className="space-y-0.5">
        <Label className="text-xs">{t(`${groupKey}.label`)}</Label>
        <p className="text-[11px] text-muted-foreground">{t(`${groupKey}.hint`)}</p>
      </div>
      <div className="grid gap-3 @2xl/appearance-pane:grid-cols-2">{children}</div>
    </section>
  )
}

function A11ySelect({
  label,
  hint,
  value,
  options,
  getLabel,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  value: string
  options: readonly { value: string; labelKey: string }[]
  getLabel: (labelKey: string) => string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={responsiveSelectClass} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {getLabel(opt.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
