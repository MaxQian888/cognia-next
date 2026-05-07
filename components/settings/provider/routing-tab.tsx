"use client"

import { useTranslations } from "next-intl"
import { ArrowRight, GitMerge, Rocket, Server } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { SettingsCard, SettingsDivider } from "@/components/settings/common/settings-section"

interface RoutingTabProps {
  providerId?: string
  providerName?: string
}

export function RoutingTab({ providerId, providerName }: RoutingTabProps) {
  const t = useTranslations("providers.routingView")

  return (
    <div className="space-y-5">
      {/* Current routing mode */}
      <SettingsCard
        icon={<GitMerge className="h-4 w-4" />}
        title={t("currentModeTitle")}
        description={t("currentModeDesc")}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Server className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{providerName ?? providerId ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{t("primaryProvider")}</p>
            </div>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {t("primaryProvider")}
            </Badge>
          </div>

          <div className="flex items-center justify-center text-xs text-muted-foreground">
            <span>Chat Request</span>
            <ArrowRight className="mx-2 h-3 w-3" />
            <span className="rounded bg-muted px-2 py-0.5 font-medium text-foreground">
              {providerName ?? providerId ?? "Default"}
            </span>
            <ArrowRight className="mx-2 h-3 w-3" />
            <span>Response</span>
          </div>
        </div>
      </SettingsCard>

      <SettingsDivider />

      {/* Model routing map */}
      <SettingsCard icon={<Server className="h-4 w-4" />} title={t("modelMappingTitle")}>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("modelMappingProvider")}
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("modelMappingModels")}
                </th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                  {t("modelMappingPriority")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-3 py-2.5 font-medium">
                  {providerName ?? providerId ?? "Default"}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">All models</td>
                <td className="px-3 py-2.5 text-right tabular-nums">1</td>
              </tr>
            </tbody>
          </table>
        </div>
      </SettingsCard>

      <SettingsDivider />

      {/* Advanced routing teaser */}
      <SettingsCard
        variant="ghost"
        icon={<Rocket className="h-4 w-4" />}
        title={t("comingSoonTitle")}
        description={t("comingSoonDesc")}
        badge={t("comingSoon")}
        badgeVariant="secondary"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            {
              label: t("loadBalancing"),
              desc: "Distribute requests across multiple providers",
            },
            {
              label: t("weightedDistribution"),
              desc: "Assign traffic weights per provider",
            },
            {
              label: t("failoverChains"),
              desc: "Define ordered fallback sequences",
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex flex-col gap-1 rounded-lg border border-dashed px-3 py-2.5"
            >
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-[11px] text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  )
}

export default RoutingTab
