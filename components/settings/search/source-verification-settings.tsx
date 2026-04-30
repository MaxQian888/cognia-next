"use client"

/**
 * SourceVerificationSettings — configure source verification for search results.
 * Adapted from Cognia: cognia-next exposes a single `setSourceVerificationSettings`
 * action, so granular setters (mode/threshold/auto-filter/etc.) are all derived
 * by patching the persisted settings object.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Globe,
  Settings2,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import {
  type SourceVerificationMode,
  type SourceVerificationSettings as VerifSettings,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
} from "@/lib/search/types"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logger"
import { DomainListInput } from "./_shared/domain-list-input"

const log = createLogger("settings.search.verification")

// Inlined here (Cognia keeps this in `lib/settings/tools`).
const VERIFICATION_MODE_KEYS: Record<
  SourceVerificationMode,
  { label: string; description: string }
> = {
  ask: { label: "mode.ask", description: "mode.askDesc" },
  auto: { label: "mode.auto", description: "mode.autoDesc" },
  disabled: { label: "mode.disabled", description: "mode.disabledDesc" },
}

interface Props {
  className?: string
  compact?: boolean
}

export function SourceVerificationSettings({ className, compact = false }: Props) {
  const t = useTranslations("sourceVerification")
  const [domainsExpanded, setDomainsExpanded] = useState(false)

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

  if (compact) {
    return (
      <div className={cn("space-y-4", className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            <Label className="text-sm font-medium">{t("title")}</Label>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              log.info("verification_enabled_changed", { enabled: v })
              patch({ enabled: v })
            }}
          />
        </div>

        {enabled && (
          <>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("verificationMode")}</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  log.info("verification_mode_changed", { mode: value })
                  patch({ mode: value as SourceVerificationMode })
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(VERIFICATION_MODE_KEYS).map(([key, { label }]) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {t(label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="text-xs">
                <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" />
                {trustedDomains.length} {t("trusted")}
              </Badge>
              <Badge variant="outline" className="text-xs">
                <XCircle className="h-3 w-3 mr-1 text-red-500" />
                {blockedDomains.length} {t("blocked")}
              </Badge>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle className="text-base">{t("title")}</CardTitle>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              log.info("verification_enabled_changed", { enabled: v })
              patch({ enabled: v })
            }}
          />
        </div>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>

      {enabled && (
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("verificationMode")}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(
                Object.entries(VERIFICATION_MODE_KEYS) as [
                  SourceVerificationMode,
                  (typeof VERIFICATION_MODE_KEYS)["ask"],
                ][]
              ).map(([key, { label, description }]) => (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        log.info("verification_mode_changed", { mode: key })
                        patch({ mode: key })
                      }}
                      className={cn(
                        "flex flex-col items-center gap-1 p-3 rounded-lg border transition-all",
                        mode === key
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border hover:border-primary/50"
                      )}
                    >
                      {key === "ask" && <ShieldQuestion className="h-5 w-5" />}
                      {key === "auto" && <ShieldCheck className="h-5 w-5" />}
                      {key === "disabled" && (
                        <ShieldAlert className="h-5 w-5 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium">{t(label)}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="max-w-xs text-xs">{t(description)}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
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

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">{t("autoFilterLow")}</Label>
              <p className="text-xs text-muted-foreground">{t("autoFilterLowDesc")}</p>
            </div>
            <Switch
              checked={autoFilterLowCredibility}
              onCheckedChange={(v) => {
                log.info("auto_filter_changed", { enabled: v })
                patch({ autoFilterLowCredibility: v })
              }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">{t("enableCrossValidation")}</Label>
              <p className="text-xs text-muted-foreground">{t("enableCrossValidationDesc")}</p>
            </div>
            <Switch
              checked={enableCrossValidation}
              onCheckedChange={(v) => {
                log.info("cross_validation_changed", { enabled: v })
                patch({ enableCrossValidation: v })
              }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm">{t("showBadges")}</Label>
              <p className="text-xs text-muted-foreground">{t("showBadgesDesc")}</p>
            </div>
            <Switch
              checked={showVerificationBadges}
              onCheckedChange={(v) => {
                log.info("show_badges_changed", { enabled: v })
                patch({ showVerificationBadges: v })
              }}
            />
          </div>

          <Collapsible open={domainsExpanded} onOpenChange={setDomainsExpanded}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between h-auto py-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  <span className="text-sm font-medium">{t("domainManagement")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {trustedDomains.length + blockedDomains.length} {t("rules")}
                  </Badge>
                  <Settings2
                    className={cn("h-4 w-4 transition-transform", domainsExpanded && "rotate-90")}
                  />
                </div>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4 space-y-4">
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
            </CollapsibleContent>
          </Collapsible>

          {mode === "auto" && autoFilterLowCredibility && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                {t("autoFilterWarning", { percentage: credibilityPercentage })}
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
