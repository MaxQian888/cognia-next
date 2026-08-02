"use client"

import { Activity, CheckCircle2, Gauge, Server } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { ProviderSection } from "../provider-section"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

interface SummarySectionProps {
  providerName: string
  /** Newest measured sample; absent until the provider has been run once. */
  latestSample?: ProviderDiagnosticSample
}

/**
 * Three-tile verdict on the provider's last run: can we reach it, are the
 * credentials good, did a real request complete. Each tile answers exactly one
 * question — they used to be a single "connected" badge that conflated all
 * three, so a reachable endpoint with a rejected key still read as healthy.
 */
export function SummarySection({ providerName, latestSample }: SummarySectionProps) {
  const t = useTranslations("providers.diagnostics")
  const authenticated = latestSample?.probe?.authenticated

  return (
    <ProviderSection
      icon={Activity}
      title={t("summary.title")}
      description={t("summary.description", { provider: providerName })}
      contentClassName="grid grid-cols-1 gap-2 @sm/diagnostics:grid-cols-3"
      data-testid="diagnostics-summary"
    >
      <div className="rounded-lg border p-2 text-center">
        <Server className="mx-auto mb-1 h-4 w-4" />
        <p className="text-[10px] text-muted-foreground">{t("summary.transport")}</p>
        <Badge variant={latestSample?.probe?.reachable ? "default" : "secondary"}>
          {latestSample?.probe?.reachable ? t("status.reachable") : t("status.unknown")}
        </Badge>
      </div>
      <div className="rounded-lg border p-2 text-center">
        <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
        <p className="text-[10px] text-muted-foreground">{t("summary.auth")}</p>
        <Badge variant={authenticated ? "default" : "secondary"}>
          {authenticated === true
            ? t("status.verified")
            : authenticated === false
              ? t("status.invalid")
              : t("status.unverified")}
        </Badge>
      </div>
      <div className="rounded-lg border p-2 text-center">
        <Gauge className="mx-auto mb-1 h-4 w-4" />
        <p className="text-[10px] text-muted-foreground">{t("summary.execution")}</p>
        <Badge variant={latestSample?.status === "completed" ? "default" : "secondary"}>
          {latestSample?.status === "completed" ? t("status.completed") : t("status.unverified")}
        </Badge>
      </div>
    </ProviderSection>
  )
}
