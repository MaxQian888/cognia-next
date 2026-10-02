"use client"

/**
 * The top of the status page: overall service status, how fresh that answer
 * is, who is observing, and the observed availability with its coverage for
 * the selected history range.
 *
 * - No snapshot yet: a skeleton, never a guessed status.
 * - No snapshot and the request failed: overall "unknown" with a retry.
 * - Stale snapshot: the last reported status in neutral colours with a
 *   prominent "out of date" label, so an old green never reads as current.
 * - Availability without observations is "No data", never 100 %.
 */

import { useLocale, useTranslations } from "next-intl"
import { Clock3Icon, GaugeIcon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { PublicStatusError } from "@/hooks/status/use-public-status"
import type {
  HistoryRange,
  PublicStatusSnapshot,
  SnapshotFreshness,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { HistoryRangeSelector, HistoryStrip } from "./history-strip"
import { MonitoringLabel, STALE_STYLE, STATUS_STYLES, usePercentLabel } from "./status-labels"
import { ageParts, formatUtcDateTime } from "./status-format"

// A CSS entrance rather than a JS one: `animate-in` only supplies the
// keyframe's starting value, so the resting state is visible whether or not
// the animation runs, and `motion-safe:` honours reduced motion.
const reveal =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500"

export interface StatusHeroProps {
  snapshot: PublicStatusSnapshot | null
  freshness: SnapshotFreshness | null
  range: HistoryRange
  ranges: readonly HistoryRange[]
  onRangeChange: (range: HistoryRange) => void
  pendingRange: boolean
  /** Set when there is no snapshot and the last request failed. */
  failure: PublicStatusError | null
  onRetry: () => void
  refreshing: boolean
}

export function StatusHero({
  snapshot,
  freshness,
  range,
  ranges,
  onRangeChange,
  pendingRange,
  failure,
  onRetry,
  refreshing,
}: StatusHeroProps) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const percent = usePercentLabel()

  const loading = snapshot === null && failure === null
  const stale = freshness?.stale ?? false
  const overall = snapshot?.overallStatus ?? "unknown"
  const style = snapshot && stale ? STALE_STYLE : STATUS_STYLES[overall]
  const OverallIcon = style.icon
  const overallText = t(`statuses.overall.${overall}`)
  const availability = snapshot?.overall.availability ?? null

  let updated: string
  if (!snapshot || !freshness) {
    updated = t("hero.lastUpdatedNever")
  } else {
    const age = ageParts(freshness.ageMs)
    updated =
      age.unit === "seconds"
        ? t("hero.lastUpdatedSeconds")
        : age.unit === "minutes"
          ? t("hero.lastUpdatedMinutes", { count: age.count })
          : t("hero.lastUpdatedHours", { count: age.count })
  }

  return (
    <section
      aria-labelledby="status-hero-title"
      className="grid grid-cols-1 border-b py-14 md:grid-cols-12 md:py-24"
      data-testid="status-hero"
    >
      <div className={cn(reveal, "relative min-w-0 md:col-span-7 md:pr-12")}>
        <p className="text-sm text-muted-foreground">{t("hero.eyebrow")}</p>
        <h1
          id="status-hero-title"
          className="mt-6 max-w-4xl text-balance text-[clamp(2.4rem,6vw,5rem)] leading-[0.98] font-semibold tracking-[-0.05em]"
        >
          {t("hero.title")}
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-muted-foreground md:text-lg">
          {t("hero.description")}
        </p>

        <div className="mt-10 space-y-4">
          {loading ? (
            <Skeleton className="h-11 w-64 rounded-pill" />
          ) : (
            <div
              role="status"
              aria-live="polite"
              data-testid="overall-status"
              data-status={overall}
              data-stale={stale || undefined}
              className={cn(
                "inline-flex max-w-full items-center gap-3 rounded-pill px-4 py-2.5 ring-1",
                style.soft,
                style.text
              )}
            >
              <OverallIcon className="size-5 shrink-0" aria-hidden />
              <span className="font-medium">
                {snapshot && stale ? t("hero.staleOverall", { status: overallText }) : overallText}
              </span>
            </div>
          )}

          {snapshot && freshness?.stale ? (
            <div
              className="flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-300"
              data-testid="freshness-warning"
            >
              <Badge variant="warning">
                {freshness.clockUncertain ? t("freshness.uncertain") : t("freshness.stale")}
              </Badge>
              <span>
                {freshness.clockUncertain
                  ? t("freshness.uncertainDescription")
                  : t("freshness.staleDescription", {
                      minutes: Math.round(snapshot.staleAfterMs / 60_000),
                    })}
              </span>
            </div>
          ) : null}

          {failure && !snapshot ? (
            <div className="max-w-xl space-y-3" role="alert" data-testid="status-unavailable">
              <p className="font-medium">{t("error.noSnapshotTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("error.noSnapshotDescription")} {t(`error.kinds.${failure.kind}`)}
              </p>
              {failure.kind === "unsupported" ? (
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                  <RefreshCwIcon aria-hidden />
                  {t("actions.reload")}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={onRetry} disabled={refreshing}>
                  <RefreshCwIcon
                    className={cn(refreshing && "motion-safe:animate-spin")}
                    aria-hidden
                  />
                  {t("actions.retry")}
                </Button>
              )}
            </div>
          ) : null}

          <div className="grid gap-1 text-sm text-muted-foreground">
            <p className="flex flex-wrap items-center gap-2" data-testid="last-updated">
              <Clock3Icon className="size-4" aria-hidden />
              <span>{updated}</span>
              {snapshot ? (
                <span className="font-mono text-xs tabular-nums">
                  {t("hero.generatedAt", { time: formatUtcDateTime(snapshot.generatedAt, locale) })}
                </span>
              ) : null}
            </p>
            <div className="flex flex-wrap items-center gap-2" data-testid="monitoring-status">
              <span>{t("hero.monitoring")}</span>
              {loading ? (
                <Skeleton className="h-4 w-20" />
              ) : (
                <MonitoringLabel status={snapshot?.monitoringStatus ?? "unknown"} />
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          reveal,
          "motion-safe:delay-100",
          "relative mt-12 flex min-w-0 flex-col gap-6 border-t pt-8 md:col-span-5 md:mt-0 md:border-t-0 md:border-l md:pt-0 md:pl-12"
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <HistoryRangeSelector
            value={range}
            ranges={ranges}
            onChange={onRangeChange}
            pending={pendingRange && !failure}
          />
          <GaugeIcon className="size-5 text-muted-foreground" aria-hidden />
        </div>

        {loading ? (
          <div className="space-y-4" data-testid="hero-skeleton">
            <Skeleton className="h-20 w-48" />
            <Skeleton className="h-5 w-full" />
          </div>
        ) : (
          <>
            {/* Sized by the hero column, not the viewport: at mid widths the
                column is narrow and two large figures side by side overlap. */}
            <div className="@container">
              <dl className="grid grid-cols-1 gap-6 @lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t("hero.availability")}
                    {snapshot ? (
                      <span className="block text-xs">
                        {t("hero.rangeFor", { range: t(`ranges.${snapshot.range}`) })}
                      </span>
                    ) : null}
                  </dt>
                  {/* Sans with tabular digits, not mono: a monospace "." takes a
                    full digit cell and splits the figure apart. */}
                  <dd
                    className="mt-2 text-[clamp(2.25rem,6vw,4rem)] leading-none font-medium tracking-[-0.05em] tabular-nums"
                    data-testid="overall-availability"
                  >
                    {percent(availability?.observedAvailability ?? null)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground" title={t("hero.coverageHint")}>
                    {t("hero.coverage")}
                    <span className="block text-xs">{t("hero.coverageHint")}</span>
                  </dt>
                  <dd
                    className="mt-2 text-[clamp(1.5rem,4vw,2.5rem)] leading-none font-medium tracking-[-0.04em] tabular-nums"
                    data-testid="overall-coverage"
                  >
                    {percent(availability?.coverage ?? null)}
                  </dd>
                </div>
              </dl>
            </div>
            {availability && availability.excludedSlots > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("hero.excluded", {
                  count: availability.excludedSlots,
                  value: percent(availability.maintenanceAdjusted.observedAvailability),
                })}
              </p>
            ) : null}
            {snapshot ? (
              <HistoryStrip
                buckets={snapshot.overall.history}
                range={snapshot.range}
                name={t("history.overallName")}
                compact
                testId="overall-history"
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
