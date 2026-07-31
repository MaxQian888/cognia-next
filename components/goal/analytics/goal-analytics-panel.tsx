"use client"

/**
 * Analytics panel for the Goals console (ADR-0019 — Analytics tab).
 *
 * Pure-data aggregates (`lib/goal/analytics.ts`) → a headline StatCard row plus
 * three theme-aware Recharts visuals: a status-distribution donut, a
 * goals-created area chart, and a token-spend bar chart. Reuses the shared
 * scheduler `StatCard` and the observability charting primitives
 * (`useThemeColors` / `paletteColor` / `TOOLTIP_STYLE`) — the genuinely
 * reusable bits — rather than the observability panel chrome.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import {
  Area,
  AreaChart,
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
import { ActivityIcon, CheckCircle2Icon, CoinsIcon, RepeatIcon, TargetIcon } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatCard } from "@/components/scheduler/stat-card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import { STAGGER_CHILD, STAGGER_CONTAINER, useReducedMotionVariants } from "@/lib/ui/motion"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import type { Goal } from "@/types/goal"

interface Props {
  goals: Goal[]
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number
}

function kfmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function pctText(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function GoalAnalyticsPanel({ goals, now }: Props) {
  const t = useTranslations("goal")
  const colors = useThemeColors()
  const containerVariants = useReducedMotionVariants(STAGGER_CONTAINER)
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)

  const analytics = useMemo(() => computeGoalAnalytics(goals, { now }), [goals, now])

  if (analytics.total === 0) {
    return (
      <Empty data-testid="goal-analytics-empty">
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

  const donutData = analytics.statusDistribution.map((s, i) => ({
    key: t(`status.${s.status}`),
    value: s.count,
    color: paletteColor(colors, i),
  }))

  return (
    <div className="space-y-6" data-testid="goal-analytics-panel">
      <motion.div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        variants={containerVariants}
        initial="initial"
        animate="animate"
      >
        <motion.div variants={childVariants}>
          <StatCard
            label={t("analytics.totalGoals")}
            value={analytics.total}
            icon={<TargetIcon className="h-5 w-5 text-muted-foreground" aria-hidden />}
            valueClassName="text-foreground"
            accentGradient="from-border to-border/50"
            iconBgClassName="bg-muted/50"
            testid="goal-analytics-stat-total"
          />
        </motion.div>
        <motion.div variants={childVariants}>
          <StatCard
            label={t("analytics.completionRate")}
            value={pctText(analytics.completionRate)}
            icon={<CheckCircle2Icon className="h-5 w-5 text-green-500" aria-hidden />}
            valueClassName="text-green-500"
            accentGradient="from-green-500 to-emerald-400"
            iconBgClassName="bg-green-500/10"
            testid="goal-analytics-stat-completion"
          />
        </motion.div>
        <motion.div variants={childVariants}>
          <StatCard
            label={t("analytics.avgTurns")}
            value={analytics.avgTurns.toFixed(1)}
            icon={<RepeatIcon className="h-5 w-5 text-blue-500" aria-hidden />}
            valueClassName="text-blue-500"
            accentGradient="from-blue-500 to-sky-400"
            iconBgClassName="bg-blue-500/10"
            testid="goal-analytics-stat-avg-turns"
          />
        </motion.div>
        <motion.div variants={childVariants}>
          <StatCard
            label={t("analytics.avgTokens")}
            value={kfmt(analytics.avgTokens)}
            icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
            valueClassName="text-violet-500"
            accentGradient="from-violet-500 to-purple-400"
            iconBgClassName="bg-violet-500/10"
            testid="goal-analytics-stat-avg-tokens"
          />
        </motion.div>
        <motion.div variants={childVariants}>
          <StatCard
            label={t("analytics.judgeFailureRate")}
            value={pctText(analytics.judgeFailureRate)}
            icon={<ActivityIcon className="h-5 w-5 text-amber-500" aria-hidden />}
            valueClassName="text-amber-500"
            accentGradient="from-amber-500 to-yellow-400"
            iconBgClassName="bg-amber-500/10"
            testid="goal-analytics-stat-judge-failure"
          />
        </motion.div>
      </motion.div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("analytics.statusDistribution")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48" data-testid="goal-analytics-donut">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 192 }}
              >
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="key"
                    cx="50%"
                    cy="50%"
                    innerRadius="55%"
                    outerRadius="80%"
                    paddingAngle={2}
                    isAnimationActive={false}
                  >
                    {donutData.map((d) => (
                      <Cell key={d.key} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {donutData.map((d) => (
                <li
                  key={d.key}
                  className="flex items-center gap-1.5"
                  data-testid="goal-analytics-legend"
                >
                  <span className="size-2 rounded-sm" style={{ backgroundColor: d.color }} />
                  <span className="text-muted-foreground">{d.key}</span>
                  <span className="tabular-nums">{d.value}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("analytics.goalsOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48" data-testid="goal-analytics-created-chart">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 192 }}
              >
                <AreaChart
                  data={analytics.timeline}
                  margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                >
                  <XAxis dataKey="day" hide />
                  <YAxis allowDecimals={false} width={28} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                  <Area
                    type="monotone"
                    dataKey="created"
                    stroke={paletteColor(colors, 1)}
                    fill={paletteColor(colors, 1)}
                    fillOpacity={0.2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("analytics.tokensOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48" data-testid="goal-analytics-tokens-chart">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 192 }}
              >
                <BarChart
                  data={analytics.timeline}
                  margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                >
                  <XAxis dataKey="day" hide />
                  <YAxis
                    width={28}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => kfmt(Number(v))}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                  <Bar dataKey="tokens" fill={paletteColor(colors, 4)} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

GoalAnalyticsPanel.displayName = "GoalAnalyticsPanel"
