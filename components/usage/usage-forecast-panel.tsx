"use client"

/**
 * Month-to-date spend, its daily run rate, and where the month is heading.
 *
 * A budget meter answers "how close am I now"; this answers "where will I be on
 * the last day", which is the question a monthly ceiling is actually about.
 * When a global monthly limit is configured the projection is drawn against it
 * on the same `QuotaBar` the budget meters use, with the date the run rate
 * crosses it.
 *
 * Self-contained like `UsageBudgetMeters`: it reads its own rows through
 * {@link useMonthForecast}, so the Usage dashboard and Settings → Usage & cost
 * mount the same component and cannot show two projections.
 */

import { useFormatter, useTranslations } from "next-intl"

import { QuotaBar } from "@/components/settings/subscription/quota-bar"
import { useMonthForecast } from "@/hooks/usage/use-month-forecast"
import { useSettingsStore } from "@/stores/settings"
import { formatBucketCost } from "@/lib/usage/session-analytics"
import { projectedLimitCrossing, type MonthForecast } from "@/lib/usage/usage-insights"
import { formatCost } from "@/types/system/usage"
import type { LimitsMeterStatus } from "@/types/subscription"

/** A projection past this share of the limit is drawn in the warning colour. */
const WARN_RATIO = 0.8

function statusFor(ratio: number): LimitsMeterStatus {
  if (ratio >= 1) return "exceeded"
  if (ratio >= WARN_RATIO) return "warn"
  return "ok"
}

export function UsageForecastPanel() {
  const { forecast, now } = useMonthForecast()
  const monthlyLimit = useSettingsStore((s) => s.settings?.costBudget?.monthlyUsd)
  if (!forecast) return null
  return <UsageForecastView forecast={forecast} now={now} monthlyLimitUsd={monthlyLimit} />
}

export interface UsageForecastViewProps {
  forecast: MonthForecast
  now: number
  /** Global monthly ceiling, when one is configured. */
  monthlyLimitUsd?: number
}

/** Presentational half, exported for tests and stories. */
export function UsageForecastView({ forecast, now, monthlyLimitUsd }: UsageForecastViewProps) {
  const t = useTranslations("usageInsights.forecast")
  const format = useFormatter()
  const floor = forecast.unpricedTurns > 0
  // A projection built on a lower bound is itself a lower bound.
  const money = (usd: number) => (floor ? `≥ ${formatCost(usd)}` : formatCost(usd))
  const limit = monthlyLimitUsd && monthlyLimitUsd > 0 ? monthlyLimitUsd : null
  const projected = forecast.projectedMonthUsd
  const crossing = limit ? projectedLimitCrossing(forecast, limit, now) : null

  const basis =
    forecast.basis === "trailing-7d"
      ? t("basis.trailing7d")
      : forecast.basis === "since-first-use"
        ? t("basis.sinceFirstUse", { days: Math.max(1, Math.round(forecast.rateWindowDays)) })
        : t("basis.insufficient")

  let limitLine: string | null = null
  if (limit) {
    const limitLabel = formatCost(limit)
    if (forecast.monthToDateUsd >= limit) {
      limitLine = t("limit.exceeded", { limit: limitLabel })
    } else if (crossing != null) {
      limitLine = t("limit.willCross", {
        limit: limitLabel,
        date: format.dateTime(new Date(crossing), { month: "short", day: "numeric" }),
      })
    } else if (projected != null) {
      limitLine = t("limit.within", {
        limit: limitLabel,
        pct: Math.round((projected / limit) * 100),
      })
    }
  }
  const ratio = limit && projected != null ? projected / limit : null

  return (
    <div className="space-y-3" data-testid="usage-forecast">
      <dl className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("monthToDate")}
          </dt>
          <dd className="truncate font-mono text-sm tabular-nums" data-testid="usage-forecast-mtd">
            {formatBucketCost(forecast.monthToDateUsd, forecast.unpricedTurns, forecast.turns)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("runRate")}
          </dt>
          <dd className="truncate font-mono text-sm tabular-nums" data-testid="usage-forecast-rate">
            {forecast.dailyRunRateUsd == null
              ? "—"
              : t("perDay", { cost: money(forecast.dailyRunRateUsd) })}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("projected")}
          </dt>
          <dd
            className="truncate font-mono text-sm font-semibold tabular-nums"
            data-testid="usage-forecast-projected"
          >
            {projected == null ? "—" : money(projected)}
          </dd>
        </div>
      </dl>

      {ratio != null && limit ? (
        <div className="space-y-1" data-testid="usage-forecast-limit">
          <QuotaBar
            pct={Math.min(100, Math.round(ratio * 100))}
            status={statusFor(ratio)}
            label={t("limit.label", { limit: formatCost(limit) })}
            className="h-1.5"
          />
        </div>
      ) : null}
      {limitLine ? (
        <p className="text-xs" data-testid="usage-forecast-limit-line">
          {limitLine}
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground" data-testid="usage-forecast-basis">
        {basis}
        {floor ? ` ${t("unpriced", { turns: forecast.unpricedTurns })}` : ""}
      </p>
    </div>
  )
}
