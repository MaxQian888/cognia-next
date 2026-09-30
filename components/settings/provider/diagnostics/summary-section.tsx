"use client"

import { Activity, CheckCircle2, Gauge, Server } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

/** The provider's last connection test, the source of its list-row / header status. */
export interface SummaryConnectionTest {
  success: boolean
  error?: string
  testedAt?: number
}

interface SummarySectionProps {
  providerName: string
  /** Newest measured sample; absent until the provider has been run once. */
  latestSample?: ProviderDiagnosticSample
  /**
   * The provider's last connection test. The list row and the detail header
   * read their Connected / Error status from it, while the tiles below only
   * read diagnostic runs, so a failed test beside "Unverified" tiles looked
   * contradictory. When the test is newer than the latest sample, the section
   * says where the status came from.
   */
  connectionTest?: SummaryConnectionTest | null
}

/**
 * Three-tile verdict on the provider's last run: can we reach it, are the
 * credentials good, did a real request complete. Each tile answers exactly one
 * question — they used to be a single "connected" badge that conflated all
 * three, so a reachable endpoint with a rejected key still read as healthy.
 */
export function SummarySection({
  providerName,
  latestSample,
  connectionTest,
}: SummarySectionProps) {
  const t = useTranslations("providers.diagnostics")
  const authenticated = latestSample?.probe?.authenticated
  const sampleAt = latestSample ? (latestSample.completedAt ?? latestSample.startedAt) : undefined
  const testIsNewer =
    !!connectionTest &&
    (sampleAt === undefined ||
      connectionTest.testedAt === undefined ||
      connectionTest.testedAt >= sampleAt)

  return (
    <SettingsBlock
      icon={<Activity />}
      title={t("summary.title")}
      description={t("summary.description", { provider: providerName })}
      contentClassName="grid grid-cols-1 gap-2 @sm/diagnostics:grid-cols-3"
      testid="diagnostics-summary"
    >
      {testIsNewer && connectionTest ? (
        <p
          className="text-xs text-muted-foreground @sm/diagnostics:col-span-3"
          data-testid="diagnostics-summary-connection-test"
          data-outcome={connectionTest.success ? "passed" : "failed"}
        >
          {connectionTest.success
            ? t("summary.connectionTestPassed")
            : connectionTest.error
              ? t("summary.connectionTestFailedWithError", { error: connectionTest.error })
              : t("summary.connectionTestFailed")}
        </p>
      ) : null}
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
    </SettingsBlock>
  )
}
