"use client"

/**
 * p50 / p95 latency per bucket for one component, with a text summary.
 *
 * Only successful attempts are timed. A bucket below the minimum sample count
 * has null percentiles and is drawn as a gap (`connectNulls={false}`), never
 * as zero. The chart is decorative for assistive technology: the summary
 * sentence above it carries the same information.
 */

import { useId } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { ComponentSnapshot } from "@/lib/status/public-status"

import { formatUtcDateTime, formatUtcDateTimeBare } from "./status-format"

export function LatencyPanel({
  latency,
  componentName,
}: {
  latency: ComponentSnapshot["latency"]
  componentName: string
}) {
  const t = useTranslations("publicStatus.latency")
  const locale = useLocale()
  const summaryId = useId()
  const { buckets, summary, minSamples } = latency
  const data = buckets.map((bucket) => ({
    start: bucket.start,
    p50: bucket.p50Ms,
    p95: bucket.p95Ms,
    samples: bucket.sampleCount,
  }))
  const gaps = buckets.filter((bucket) => bucket.p50Ms === null).length
  const hasSummary = summary.p50Ms !== null && summary.p95Ms !== null
  const summaryText = hasSummary
    ? t("summary", { p50: summary.p50Ms!, p95: summary.p95Ms!, count: summary.sampleCount })
    : t("empty")
  const first = buckets[0]
  const lastBucket = buckets[buckets.length - 1]

  return (
    <div className="min-w-0">
      <h4 className="text-sm font-medium">{t("title")}</h4>
      <p
        id={summaryId}
        className="mt-2 text-sm leading-6 text-muted-foreground"
        data-testid="latency-summary"
      >
        {summaryText} {buckets.length > 0 ? t("gaps", { gaps }) : null}
      </p>
      {first && lastBucket ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">
          {t("window", {
            start: formatUtcDateTimeBare(first.start, locale),
            end: formatUtcDateTimeBare(lastBucket.end, locale),
          })}
        </p>
      ) : null}
      {buckets.length > 0 ? (
        <div
          className="mt-4 h-44 w-full"
          role="img"
          aria-label={t("chartLabel", { component: componentName })}
          aria-describedby={summaryId}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.55} />
              <XAxis dataKey="start" hide />
              <YAxis hide domain={[0, "auto"]} />
              <Tooltip
                contentStyle={{
                  borderRadius: "0.625rem",
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  color: "var(--foreground)",
                  fontSize: "0.75rem",
                }}
                labelFormatter={(value) => formatUtcDateTime(String(value), locale)}
                formatter={(value, name) => [
                  t("value", { value: Number(value) }),
                  name === "p95" ? t("p95") : t("p50"),
                ]}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="p50"
                stroke="var(--chart-2)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                name="p95"
                stroke="var(--chart-4)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      <div
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-hidden
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-[var(--chart-2)]" />
          {t("p50")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-[var(--chart-4)]" />
          {t("p95")}
        </span>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {t("minSamples", { min: minSamples })}
      </p>
    </div>
  )
}
