"use client"

/**
 * SourceVerificationSettings — configure source verification for search results.
 * cognia-next exposes a single `setSourceVerificationSettings` action, so granular
 * setters (mode/threshold/auto-filter/etc.) are all derived by patching the
 * persisted settings object.
 */

import { useTranslations } from "next-intl"
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Globe,
} from "lucide-react"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import {
  SettingsToggle,
  SettingsGroup,
  SettingsAlert,
} from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import {
  type SourceVerificationMode,
  type SourceVerificationSettings as VerifSettings,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
} from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"
import { DomainListInput } from "./_shared/domain-list-input"
import { SegmentedControl, type SegmentedOption } from "./_shared/segmented-control"

const log = createLogger("settings.search.verification")

const MODES: {
  value: SourceVerificationMode
  labelKey: string
  descKey: string
  icon: React.ReactNode
}[] = [
  {
    value: "ask",
    labelKey: "mode.ask",
    descKey: "mode.askDesc",
    icon: <ShieldQuestion className="h-5 w-5" />,
  },
  {
    value: "auto",
    labelKey: "mode.auto",
    descKey: "mode.autoDesc",
    icon: <ShieldCheck className="h-5 w-5" />,
  },
  {
    value: "disabled",
    labelKey: "mode.disabled",
    descKey: "mode.disabledDesc",
    icon: <ShieldAlert className="h-5 w-5 text-muted-foreground" />,
  },
]

interface Props {
  className?: string
}

export function SourceVerificationSettings({ className }: Props) {
  const t = useTranslations("sourceVerification")

  const settings = useSettingsStore((s) => s.settings)
  const setVerifSettings = useSettingsStore((s) => s.setSourceVerificationSettings)

  const verif: VerifSettings =
    settings?.sourceVerificationSettings ?? DEFAULT_SOURCE_VERIFICATION_SETTINGS

  const {
    enabled,
    mode,
    minimumCredibilityScore,
    autoFilterLowCredibility,
    showVerificationBadges,
    trustedDomains,
    blockedDomains,
    enableCrossValidation,
  } = verif

  const patch = (p: Partial<VerifSettings>) => void setVerifSettings({ ...verif, ...p })

  const sanitizeDomain = (raw: string) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")

  const credibilityPercentage = Math.round(minimumCredibilityScore * 100)

  const modeOptions: SegmentedOption<SourceVerificationMode>[] = MODES.map((m) => ({
    value: m.value,
    label: t(m.labelKey),
    description: t(m.descKey),
    icon: m.icon,
  }))

  return (
    <div className={cn("space-y-4", className)}>
      <SettingsToggle
        id="source-verification-enabled"
        label={t("title")}
        description={t("description")}
        checked={enabled}
        onCheckedChange={(v) => {
          log.info("verification_enabled_changed", { enabled: v })
          patch({ enabled: v })
        }}
      />

      {enabled && (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("verificationMode")}</Label>
            <SegmentedControl
              variant="cards"
              value={mode}
              onValueChange={(v) => {
                log.info("verification_mode_changed", { mode: v })
                patch({ mode: v })
              }}
              options={modeOptions}
              aria-label={t("verificationMode")}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t("minimumThreshold")}</Label>
              <span className="text-sm font-mono text-muted-foreground">
                {credibilityPercentage}%
              </span>
            </div>
            <Slider
              value={[credibilityPercentage]}
              onValueChange={([value]) => patch({ minimumCredibilityScore: value / 100 })}
              onValueCommit={([value]) => log.info("verification_threshold_changed", { value })}
              min={0}
              max={100}
              step={5}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t("loose")}</span>
              <span>{t("strict")}</span>
            </div>
          </div>

          <SettingsToggle
            id="source-verification-auto-filter"
            label={t("autoFilterLow")}
            description={t("autoFilterLowDesc")}
            checked={autoFilterLowCredibility}
            onCheckedChange={(v) => {
              log.info("auto_filter_changed", { enabled: v })
              patch({ autoFilterLowCredibility: v })
            }}
          />

          <SettingsToggle
            id="source-verification-cross-validation"
            label={t("enableCrossValidation")}
            description={t("enableCrossValidationDesc")}
            checked={enableCrossValidation}
            onCheckedChange={(v) => {
              log.info("cross_validation_changed", { enabled: v })
              patch({ enableCrossValidation: v })
            }}
          />

          <SettingsToggle
            id="source-verification-show-badges"
            label={t("showBadges")}
            description={t("showBadgesDesc")}
            checked={showVerificationBadges}
            onCheckedChange={(v) => {
              log.info("show_badges_changed", { enabled: v })
              patch({ showVerificationBadges: v })
            }}
          />

          <SettingsGroup
            title={t("domainManagement")}
            icon={<Globe className="h-4 w-4" />}
            badge={`${trustedDomains.length + blockedDomains.length} ${t("rules")}`}
          >
            <DomainListInput
              label={
                <Label className="text-sm flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  {t("trustedDomains")}
                </Label>
              }
              placeholder={t("trustedDomainPlaceholder")}
              domains={trustedDomains}
              onAdd={(raw) => {
                const domain = sanitizeDomain(raw)
                if (!domain || trustedDomains.includes(domain)) return
                log.info("trusted_domain_added", { domain })
                patch({ trustedDomains: [...trustedDomains, domain] })
              }}
              onRemove={(domain) => {
                log.info("trusted_domain_removed", { domain })
                patch({ trustedDomains: trustedDomains.filter((d) => d !== domain) })
              }}
              badgeIcon={<CheckCircle2 className="h-3 w-3 mr-1 text-green-500" />}
              showAddButton
              scrollable
              removeAriaLabel={(d) => `Remove ${d}`}
            />

            <DomainListInput
              label={
                <Label className="text-sm flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-red-500" />
                  {t("blockedDomains")}
                </Label>
              }
              placeholder={t("blockedDomainPlaceholder")}
              domains={blockedDomains}
              onAdd={(raw) => {
                const domain = sanitizeDomain(raw)
                if (!domain || blockedDomains.includes(domain)) return
                log.info("blocked_domain_added", { domain })
                patch({ blockedDomains: [...blockedDomains, domain] })
              }}
              onRemove={(domain) => {
                log.info("blocked_domain_removed", { domain })
                patch({ blockedDomains: blockedDomains.filter((d) => d !== domain) })
              }}
              badgeIcon={<XCircle className="h-3 w-3 mr-1 text-red-500" />}
              showAddButton
              scrollable
              removeAriaLabel={(d) => `Remove ${d}`}
            />
          </SettingsGroup>

          {mode === "auto" && autoFilterLowCredibility && (
            <SettingsAlert icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}>
              {t("autoFilterWarning", { percentage: credibilityPercentage })}
            </SettingsAlert>
          )}
        </>
      )}
    </div>
  )
}
