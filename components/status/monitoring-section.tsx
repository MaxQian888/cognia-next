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
import { EyeIcon, RadarIcon, ServerIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  pickLocalized,
  type MonitoringStatus,
  type ProbeHealth,
  type ProbeSummary,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import {
  IconTile,
  MonitoringLabel,
  PanelEmpty,
  SectionHeading,
  StatusPanel,
  type IconTone,
} from "./status-labels"
import { formatUtcDateTime } from "./status-format"

const HEALTH_DOT: Record<ProbeHealth, string> = {
  healthy: "bg-emerald-500",
  stale: "bg-amber-500",
  error: "bg-rose-600",
  disabled: "bg-muted-foreground/45",
  unknown: "bg-muted-foreground/45",
}

const MONITORING_TILE: Record<MonitoringStatus, IconTone> = {
  healthy: "success",
  limited: "warning",
  degraded: "danger",
  unknown: "neutral",
}

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
      className="scroll-mt-24 pb-12 md:pb-16"
    >
      <SectionHeading
        id="monitoring-title"
        icon={RadarIcon}
        title={t("monitoring.title")}
        description={t("monitoring.description")}
      />

      <StatusPanel className="mt-6">
        <div className="flex items-start gap-4 p-5 sm:p-6">
          <IconTile icon={EyeIcon} tone={MONITORING_TILE[monitoringStatus]} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <MonitoringLabel status={monitoringStatus} />
              <span className="text-muted-foreground">
                {t(`monitoring.statusHints.${monitoringStatus}`)}
              </span>
            </div>
            <p
              className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground"
              data-testid="monitoring-coverage"
            >
              {t("monitoring.coverage", { count: active.length })}
            </p>
          </div>
        </div>
      </StatusPanel>

      {probes.length === 0 ? (
        <StatusPanel className="mt-4">
          <PanelEmpty icon={ServerIcon} title={t("monitoring.empty")} />
        </StatusPanel>
      ) : (
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {probes.map((probe) => (
            <li key={probe.id} className="min-w-0" data-testid="probe-card">
              <StatusPanel className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3 p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    <IconTile icon={ServerIcon} />
                    <div className="min-w-0">
                      <p className="font-semibold tracking-tight">
                        {pickLocalized(probe.label, locale)}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
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
                  </div>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 text-sm font-medium",
                      HEALTH_TONE[probe.health]
                    )}
                  >
                    <span
                      className={cn("size-2 rounded-full", HEALTH_DOT[probe.health])}
                      aria-hidden
                    />
                    {t(`probeHealth.${probe.health}`)}
                  </span>
                </div>
                <div className="flex-1 pb-4">
                  <div className="flex flex-wrap gap-1.5 px-5">
                    <Badge variant="outline" className="font-normal">
                      {t(`sources.${probe.source}`)}
                    </Badge>
                    {probe.reference ? (
                      <Badge variant="secondary" className="font-normal">
                        {t("monitoring.reference")}
                      </Badge>
                    ) : null}
                  </div>
                  <ul className="mx-5 mt-4 divide-y rounded-xl border text-sm">
                    {probe.profiles.map((profile) => (
                      <li key={profile.id} className="px-3.5 py-2.5">
                        <span className="font-medium">
                          {t("monitoring.cadence", {
                            profile: t(`profiles.${profile.id}`),
                            seconds: profile.cadenceSeconds,
                          })}
                        </span>
                        {profile.simulatedOrigin ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {t("evidence.simulatedOrigin")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {probe.reason ? (
                    <p className="mx-5 mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      {t(`reasons.${probe.reason}`)}
                    </p>
                  ) : null}
                </div>
                <p className="grid gap-1 border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground tabular-nums sm:grid-cols-2">
                  <span>{t("monitoring.lastAttempt", { time: time(probe.lastAttemptAt) })}</span>
                  <span>{t("monitoring.lastSuccess", { time: time(probe.lastSuccessAt) })}</span>
                </p>
              </StatusPanel>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
