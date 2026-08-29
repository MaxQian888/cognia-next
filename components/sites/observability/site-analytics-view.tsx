"use client"

/**
 * Cloudflare Worker analytics, as numbers and trends rather than a JSON dump.
 *
 * Four headline figures and two trends. The figures are stat tiles, not a
 * chart: a single number is not something a bar chart improves.
 *
 * **Requests and errors are never plotted together.** They differ by two to
 * four orders of magnitude, so a shared axis flattens errors onto the baseline
 * and a second y-axis invents a correlation that is not in the data. Two
 * single-series small multiples instead — which is also why neither needs a
 * legend: the panel title names its one series.
 *
 * Colours: requests on `chart-2`, error rate on `destructive`. The obvious
 * pairing — `chart-1` beside `destructive` — fails colour-vision separation in
 * light mode (ΔE 7.5 normal-vision against a floor of 15), and would be an
 * adjacency problem in any case. `destructive` is legitimate here because the
 * series genuinely means bad, and single-series plotting leaves no adjacent
 * pair to confuse. Resolved through `useThemeColors` because recharts writes
 * SVG presentation attributes, which cannot read `var()`.
 */
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Area,
  AreaChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ActivityIcon, EyeIcon, TriangleAlertIcon, UsersIcon } from "lucide-react"

import { StatCard } from "@/components/observability/stat-card"
import { Surface } from "@/components/surface/surface"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { CHART_MARGINS, TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { formatBytesCompact, formatPercent } from "@/lib/observability/format-utils"
import type { SiteAnalyticsView } from "@/lib/sites/cloudflare/observability-parse"

function compact(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

export interface SiteAnalyticsPanelProps {
  view: SiteAnalyticsView
}

export function SiteAnalyticsPanel({ view }: SiteAnalyticsPanelProps) {
  const t = useTranslations("sites")
  const colors = useThemeColors()
  const [tableView, setTableView] = useState(false)

  const errorRate = view.worker.totals.requests
    ? view.worker.totals.errors / view.worker.totals.requests
    : 0

  const series = useMemo(
    () =>
      view.worker.points.map((point) => ({
        ...point,
        errorRate: point.requests ? point.errors / point.requests : 0,
      })),
    [view.worker.points]
  )

  if (view.worker.points.length === 0 && view.providerErrors.length === 0) {
    return (
      <Empty role="status" className="gap-2 px-4 py-10" data-testid="site-analytics-empty">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("observability.analytics.noData")}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="space-y-3" data-testid="site-analytics">
      {view.providerErrors.length > 0 ? (
        <p className="text-xs text-warning" data-testid="site-analytics-partial">
          {t("observability.analytics.partial", { detail: view.providerErrors.join("; ") })}
        </p>
      ) : null}

      <Surface
        layer="raised"
        radius="panel"
        className="grid grid-cols-2 gap-px overflow-hidden border @xl/site-pane:grid-cols-4"
      >
        <StatCard
          icon={ActivityIcon}
          label={t("observability.analytics.requests")}
          value={compact(view.worker.totals.requests)}
          color="bg-chart-2/10 text-chart-2"
          data-testid="site-analytics-requests"
        />
        <StatCard
          icon={TriangleAlertIcon}
          label={t("observability.analytics.errors")}
          value={compact(view.worker.totals.errors)}
          sub={t("observability.analytics.errorRate", { rate: formatPercent(errorRate, 2) })}
          color="bg-destructive/10 text-destructive"
          data-testid="site-analytics-errors"
        />
        <StatCard
          icon={EyeIcon}
          label={t("observability.analytics.pageViews")}
          value={view.web ? compact(view.web.totals.pageViews) : "—"}
          sub={view.web ? formatBytesCompact(view.web.totals.bytes) : undefined}
          color="bg-chart-3/10 text-chart-3"
          data-testid="site-analytics-page-views"
        />
        <StatCard
          icon={UsersIcon}
          label={t("observability.analytics.uniques")}
          value={view.web ? compact(view.web.totals.uniques) : "—"}
          color="bg-chart-4/10 text-chart-4"
          data-testid="site-analytics-uniques"
        />
      </Surface>

      <div className="flex justify-end">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => setTableView(!tableView)}
          data-testid="site-analytics-view-toggle"
        >
          {tableView
            ? t("observability.analytics.chartView")
            : t("observability.analytics.tableView")}
        </Button>
      </div>

      {tableView ? (
        <SiteAnalyticsTable view={view} />
      ) : (
        // Small multiples, one series each: requests and errors are orders of
        // magnitude apart, and a shared or second axis would misrepresent both.
        <div className="grid gap-3 @2xl/site-pane:grid-cols-2">
          <TrendPanel
            title={t("observability.analytics.requests")}
            data={series}
            dataKey="requests"
            color={colors["chart-2"]}
            gridColor={colors["muted-foreground"]}
            format={compact}
            testId="site-analytics-requests-chart"
          />
          <TrendPanel
            title={t("observability.analytics.errorRate")}
            data={series}
            dataKey="errorRate"
            color={colors.destructive}
            gridColor={colors["muted-foreground"]}
            format={(value) => formatPercent(value, 1)}
            testId="site-analytics-error-rate-chart"
          />
        </div>
      )}
    </div>
  )
}

/** One series, one axis, a recessive solid grid, and a label on the last point. */
function TrendPanel({
  title,
  data,
  dataKey,
  color,
  gridColor,
  format,
  testId,
}: {
  title: string
  data: Array<Record<string, unknown>>
  dataKey: string
  color: string
  gridColor: string
  format: (value: number) => string
  testId: string
}) {
  return (
    <Surface layer="raised" radius="panel" className="border p-3" data-testid={testId}>
      <h4 className="text-xs font-medium">{title}</h4>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={CHART_MARGINS}>
            {/* Solid hairline: dashed gridlines are noise, and read as data. */}
            <CartesianGrid stroke={gridColor} strokeOpacity={0.15} vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(value: number) => format(value)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number) => [format(value), title]}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.18}
              dot={false}
              isAnimationActive={false}
            >
              {/* One direct label, on the last point — never a number per point. */}
              <LabelList
                dataKey={dataKey}
                position="right"
                fontSize={10}
                formatter={(value: number, _entry: unknown, index: number) =>
                  index === data.length - 1 ? format(value) : ""
                }
              />
            </Area>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Surface>
  )
}

/**
 * The same numbers as rows.
 *
 * Required by the accessibility pass, and the relief for the dark-mode contrast
 * of a single-series area: identity must never be colour-alone.
 */
function SiteAnalyticsTable({ view }: { view: SiteAnalyticsView }) {
  const t = useTranslations("sites")
  return (
    <Surface layer="raised" radius="panel" className="overflow-hidden border">
      <table className="w-full text-xs" data-testid="site-analytics-table">
        <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">
              {t("observability.analytics.date")}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">
              {t("observability.analytics.requests")}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">
              {t("observability.analytics.errors")}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">
              {t("observability.analytics.subrequests")}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.worker.points.map((point) => (
            <tr key={point.date} className="border-t">
              <td className="px-3 py-1.5 font-mono">{point.date}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{point.requests}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{point.errors}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{point.subrequests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Surface>
  )
}
