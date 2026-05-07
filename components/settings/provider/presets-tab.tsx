"use client"

import { useTranslations } from "next-intl"
import { Zap, DollarSign, Shield, Scale, Server } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  SettingsAlert,
  SettingsCard,
  SettingsDivider,
  SettingsGrid,
} from "@/components/settings/common/settings-section"

interface PresetsTabProps {
  providerId?: string
  providerName?: string
}

const PRESETS = [
  {
    key: "fastest",
    icon: Zap,
    color: "text-amber-500",
  },
  {
    key: "cheapest",
    icon: DollarSign,
    color: "text-green-500",
  },
  {
    key: "mostReliable",
    icon: Shield,
    color: "text-blue-500",
  },
  {
    key: "balanced",
    icon: Scale,
    color: "text-violet-500",
  },
] as const

export function PresetsTab({ providerId, providerName }: PresetsTabProps) {
  const t = useTranslations("providers.presetsView")

  return (
    <div className="space-y-5">
      {/* Auto-routing note */}
      <SettingsAlert icon={<Server className="h-4 w-4" />} title={t("comingSoon")}>
        <p className="text-xs">{t("autoRoutingNote")}</p>
      </SettingsAlert>

      {/* Preset cards */}
      <SettingsGrid columns={2}>
        {PRESETS.map((preset) => {
          const Icon = preset.icon
          return (
            <SettingsCard
              key={preset.key}
              icon={<Icon className={`h-4 w-4 ${preset.color}`} />}
              title={t(preset.key)}
              description={t(`${preset.key}Desc`)}
              badge={t("comingSoon")}
              badgeVariant="secondary"
              headerAction={
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
                  {t("select")}
                </Button>
              }
            >
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {preset.key === "fastest"
                    ? "<200ms target"
                    : preset.key === "cheapest"
                      ? "Lowest $/token"
                      : preset.key === "mostReliable"
                        ? "99.9%+ uptime"
                        : "Auto-weighted"}
                </Badge>
              </div>
            </SettingsCard>
          )
        })}
      </SettingsGrid>

      <SettingsDivider />

      {/* Current config */}
      <SettingsCard
        variant="ghost"
        icon={<Server className="h-4 w-4" />}
        title={t("currentConfig")}
      >
        <p className="text-sm text-muted-foreground">
          {t("usingProvider", {
            provider: providerName ?? providerId ?? "Default",
          })}
        </p>
      </SettingsCard>
    </div>
  )
}

export default PresetsTab
