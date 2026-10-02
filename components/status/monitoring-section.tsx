"use client"

/**
 * Who measures the relay, from where, and how recently.
 *
 * Observer health is shown apart from service health. The coverage sentence
 * says how many places the evidence comes from and that this is not a global
 * or mobile-network guarantee; registered location and provider come from
 * the server registry, localized with the API's own bilingual text.
 */

import { useLocale, useTranslations } from "next-intl"
import { RadarIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  pickLocalized,
  type MonitoringStatus,
  type ProbeHealth,
  type ProbeSummary,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { MonitoringLabel, SectionHeading } from "./status-labels"
import { formatUtcDateTime } from "./status-format"

const HEALTH_TONE: Record<ProbeHealth, string> = {
  healthy: "text-emerald-700 dark:text-emerald-300",
  stale: "text-amber-800 dark:text-amber-300",
  error: "text-rose-700 dark:text-rose-300",
  disabled: "text-muted-foreground",
  unknown: "text-muted-foreground",
}

export function MonitoringSection({
  probes,
  monitoringStatus,
}: {
  probes: readonly ProbeSummary[]
  monitoringStatus: MonitoringStatus
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const active = probes.filter((probe) => probe.health !== "disabled")
  const time = (value: string | null) =>
    value ? formatUtcDateTime(value, locale) : t("monitoring.never")

  return (
    <section
      id="monitoring"
      aria-labelledby="monitoring-title"
      className="scroll-mt-24 border-t py-14 md:py-20"
    >
      <SectionHeading
        id="monitoring-title"
        icon={RadarIcon}
        title={t("monitoring.title")}
        description={t("monitoring.description")}
      />
      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
        <MonitoringLabel status={monitoringStatus} />
        <span className="text-muted-foreground">
          {t(`monitoring.statusHints.${monitoringStatus}`)}
        </span>
      </div>
      <p
        className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground"
        data-testid="monitoring-coverage"
      >
        {t("monitoring.coverage", { count: active.length })}
      </p>

      {probes.length === 0 ? (
        <p className="mt-8 border-y py-6 text-sm text-muted-foreground">{t("monitoring.empty")}</p>
      ) : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {probes.map((probe) => (
            <li key={probe.id} className="min-w-0 rounded-lg border p-4" data-testid="probe-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{pickLocalized(probe.label, locale)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {probe.location
                      ? pickLocalized(probe.location, locale)
                      : t("monitoring.locationUnknown")}
                    {probe.provider ? (
                      <span className="block text-xs">
                        {t("monitoring.provider", { provider: probe.provider })}
                      </span>
                    ) : null}
                  </p>
                </div>
                <span className={cn("text-sm font-medium", HEALTH_TONE[probe.health])}>
                  {t(`probeHealth.${probe.health}`)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="font-normal">
                  {t(`sources.${probe.source}`)}
                </Badge>
                {probe.reference ? (
                  <Badge variant="secondary" className="font-normal">
                    {t("monitoring.reference")}
                  </Badge>
                ) : null}
              </div>
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {probe.profiles.map((profile) => (
                  <li key={profile.id}>
                    {t("monitoring.cadence", {
                      profile: t(`profiles.${profile.id}`),
                      seconds: profile.cadenceSeconds,
                    })}
                    {profile.simulatedOrigin ? (
                      <span className="block">{t("evidence.simulatedOrigin")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 grid gap-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                <span>{t("monitoring.lastAttempt", { time: time(probe.lastAttemptAt) })}</span>
                <span>{t("monitoring.lastSuccess", { time: time(probe.lastSuccessAt) })}</span>
              </p>
              {probe.reason ? (
                <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                  {t(`reasons.${probe.reason}`)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
