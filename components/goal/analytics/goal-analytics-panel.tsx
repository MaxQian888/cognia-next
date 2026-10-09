"use client"

/**
 * Analytics for the Goals console (ADR-0019 — Analytics tab).
 *
 * Pure-data aggregates (`lib/goal/analytics.ts`) → a hairline headline strip
 * (the shared `StatStrip`) and three Recharts views that share one divided
 * panel: status distribution, goals created per day, tokens spent per day.
 *
 * What changed from the card grid it replaces, and why:
 *  - The donut colours each status in the tone it has everywhere else
 *    (`goalStatusChartColor`); a positional palette painted "completed" orange.
 *  - Goals created per day are bars. A smoothed area over sparse integer
 *    counts drew a sine wave between the days a goal was created.
 *  - The token axis is wide enough for its labels and uses the same compact
 *    format as every other token count; at 28px it clipped them to "‹".
 *  - The x axes show dates.
 *  - While the first read is in flight it says so (`loading`), instead of
 *    painting the "no goals yet" empty state for a frame.
 *  - Five stat cards became one six-cell strip (total spend joined them, so
 *    the strip divides evenly at every width), and three cards one panel.
 */

import { useMemo } from "react"
import { useFormatter, useLocale, useTranslations } from "next-intl"
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { TargetIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { Surface } from "@/components/surface/surface"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { formatGoalTokens } from "@/lib/goal/format"
import type { Goal } from "@/types/goal"

import { goalStatusChartColor } from "../goal-status-style"

interface Props {
  goals: Goal[]
  /** The first read is still in flight. */
  loading?: boolean
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number
}

function pctText(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" }

export function GoalAnalyticsPanel({ goals, loading = false, now }: Props) {
  const t = useTranslations("goal")
  const format = useFormatter()
  const locale = useLocale()

  const analytics = useMemo(() => computeGoalAnalytics(goals, { now }), [goals, now])

  if (loading) {
    return (
      <div className="space-y-6" aria-busy data-testid="goal-analytics-loading">
        <Skeleton className="h-14 w-full rounded-panel" />
        <Skeleton className="h-64 w-full rounded-panel" />
      </div>
    )
  }

  if (analytics.total === 0) {
    return (
      <Empty className="rounded-panel border border-dashed" data-testid="goal-analytics-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TargetIcon className="size-5" aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("analytics.title")}</EmptyTitle>
          <EmptyDescription>{t("analytics.empty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const donutData = analytics.statusDistribution.map((slice) => ({
    status: slice.status,
    key: t(`status.${slice.status}`),
    value: slice.count,
    ...goalStatusChartColor(slice.status),
  }))

  const stats: StatStripItem[] = [
    { id: "total", label: t("analytics.totalGoals"), value: analytics.total },
    {
      id: "completion",
      label: t("analytics.completionRate"),
      value: analytics.terminal > 0 ? pctText(analytics.completionRate) : "—",
      tone: analytics.terminal > 0 ? "positive" : "neutral",
    },
    { id: "avg-turns", label: t("analytics.avgTurns"), value: analytics.avgTurns.toFixed(1) },
    {
      id: "avg-tokens",
      label: t("analytics.avgTokens"),
      value: formatGoalTokens(analytics.avgTokens, locale),
    },
    {
      id: "token-spend",
      label: t("analytics.tokenSpend"),
      value: formatGoalTokens(analytics.totalTokens, locale),
    },
    {
      id: "judge-failure",
      label: t("analytics.judgeFailureRate"),
      value: pctText(analytics.judgeFailureRate),
      tone: analytics.judgeFailureRate > 0.25 ? "attention" : "neutral",
    },
  ]

  const dayLabel = (ts: number) =>
    format.dateTime(new Date(ts), { month: "numeric", day: "numeric" })

  return (
    <div className="@container/console-pane space-y-6" data-testid="goal-analytics-panel">
      <StatStrip
        stats={stats}
        pane="console-pane"
        testId="goal-analytics-stats"
        cellTestIdPrefix="goal-analytics-stat"
      />

      {/* One panel, three views divided by hairlines — not three cards. */}
      <Surface
        layer="raised"
        radius="panel"
        className="@container/goal-charts overflow-hidden border"
      >
        <div className="grid divide-y @3xl/goal-charts:grid-cols-3 @3xl/goal-charts:divide-x @3xl/goal-charts:divide-y-0">
          <ChartFigure title={t("analytics.statusDistribution")}>
            <div className="h-44" data-testid="goal-analytics-donut">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 176 }}
              >
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="key"
                    cx="50%"
                    cy="50%"
                    innerRadius="58%"
                    outerRadius="85%"
                    paddingAngle={2}
                    stroke="var(--card)"
                    isAnimationActive={false}
                  >
                    {donutData.map((slice) => (
                      <Cell key={slice.status} fill={slice.fill} fillOpacity={slice.opacity} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {donutData.map((slice) => (
                <li
                  key={slice.status}
                  className="flex min-w-0 items-center gap-1.5"
                  data-testid="goal-analytics-legend"
                >
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: slice.fill, opacity: slice.opacity }}
                    aria-hidden
                  />
                  <span className="truncate text-muted-foreground first-letter:uppercase">
                    {slice.key}
                  </span>
                  <span className="ml-auto tabular-nums">{slice.value}</span>
                </li>
              ))}
            </ul>
          </ChartFigure>

          <ChartFigure title={t("analytics.goalsOverTime")}>
            <div className="h-52" data-testid="goal-analytics-created-chart">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 208 }}
              >
                <BarChart
                  data={analytics.timeline}
                  margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
                >
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(value) => dayLabel(Number(value))}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    allowDecimals={false}
                    width={24}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                    labelFormatter={(value) => dayLabel(Number(value))}
                    formatter={(value) => [value, t("analytics.createdSeries")]}
                  />
                  <Bar
                    dataKey="created"
                    fill="var(--chart-2)"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartFigure>

          <ChartFigure title={t("analytics.tokensOverTime")}>
            <div className="h-52" data-testid="goal-analytics-tokens-chart">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 208 }}
              >
                <BarChart
                  data={analytics.timeline}
                  margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
                >
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(value) => dayLabel(Number(value))}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    width={44}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatGoalTokens(Number(value), locale)}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                    labelFormatter={(value) => dayLabel(Number(value))}
                    formatter={(value) => [
                      format.number(Number(value)),
                      t("analytics.tokensSeries"),
                    ]}
                  />
                  <Bar
                    dataKey="tokens"
                    fill="var(--chart-1)"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartFigure>
        </div>
      </Surface>
    </div>
  )
}

function ChartFigure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <figure className="min-w-0 p-4">
      <figcaption className="mb-3 text-sm font-medium">{title}</figcaption>
      {children}
    </figure>
  )
}

GoalAnalyticsPanel.displayName = "GoalAnalyticsPanel"
