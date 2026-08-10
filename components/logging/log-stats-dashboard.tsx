"use client"

/**
 * LogStatsDashboard
 *
 * Recharts-based visualization dashboard for log analytics.
 * Shows level distribution, log volume over time, module activity,
 * summary stat cards, error trend detection, and top errors.
 */

import { useId, useMemo } from "react"
import { useTranslations, useLocale } from "next-intl"
import {
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Activity,
  AlertTriangle,
  Clock,
  Layers,
  Gauge,
  Hash,
  Grid3X3,
  AlertCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { StatCard } from "@/components/observability/stat-card"
import { TOOLTIP_STYLE, CHART_MARGINS } from "@/lib/observability/chart-config"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import type { StructuredLogEntry, LogLevel } from "@cognia/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

export interface LogStatsDashboardProps {
  logs: StructuredLogEntry[]
  logRate?: number
  nativeLogging?: NativeLoggingReadiness
  onSearchFilter?: (query: string) => void
  className?: string
}

function DashboardSection({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  const titleId = useId()

  return (
    <section aria-labelledby={titleId} className={cn("min-w-0 border-y bg-background", className)}>
      <header className="border-b px-4 py-3">
        <h3 id={titleId} className="text-sm font-medium">
          {title}
        </h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/**
 * Compute time-bucketed log counts for the volume chart.
 */
function computeVolumeBuckets(
  logs: StructuredLogEntry[],
  bucketMinutes = 5,
  locale = "en"
): { time: string; info: number; warn: number; error: number; other: number }[] {
  if (logs.length === 0) return []

  const bucketMs = bucketMinutes * 60 * 1000
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const first = new Date(sorted[0].timestamp).getTime()
  const last = new Date(sorted[sorted.length - 1].timestamp).getTime()
  const bucketCount = Math.max(1, Math.ceil((last - first) / bucketMs) + 1)
  const capped = Math.min(bucketCount, 96)

  const buckets: { time: string; info: number; warn: number; error: number; other: number }[] = []
  const startTime = last - (capped - 1) * bucketMs

  for (let i = 0; i < capped; i++) {
    const bucketStart = startTime + i * bucketMs
    buckets.push({
      time: new Date(bucketStart).toLocaleTimeString(locale, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }),
      info: 0,
      warn: 0,
      error: 0,
      other: 0,
    })
  }

  for (const log of sorted) {
    const ts = new Date(log.timestamp).getTime()
    const idx = Math.floor((ts - startTime) / bucketMs)
    if (idx < 0 || idx >= capped) continue

    if (log.level === "error" || log.level === "fatal") {
      buckets[idx].error++
    } else if (log.level === "warn") {
      buckets[idx].warn++
    } else if (log.level === "info") {
      buckets[idx].info++
    } else {
      buckets[idx].other++
    }
  }

  return buckets
}

function computeErrorTrendData(volumeData: ReturnType<typeof computeVolumeBuckets>) {
  if (volumeData.length === 0) {
    return []
  }

  const half = Math.max(1, Math.ceil(volumeData.length / 2))
  const current = volumeData.slice(-half)
  const previous = volumeData.slice(
    Math.max(0, volumeData.length - half * 2),
    Math.max(0, volumeData.length - half)
  )

  return current.map((bucket, index) => {
    const currentTotal = bucket.info + bucket.warn + bucket.error + bucket.other
    const previousBucket = previous[index]
    const previousTotal = previousBucket
      ? previousBucket.info + previousBucket.warn + previousBucket.error + previousBucket.other
      : 0
    return {
      time: bucket.time,
      current: currentTotal > 0 ? Number(((bucket.error / currentTotal) * 100).toFixed(1)) : 0,
      previous:
        previousBucket && previousTotal > 0
          ? Number(((previousBucket.error / previousTotal) * 100).toFixed(1))
          : 0,
    }
  })
}

export function LogStatsDashboard({
  logs,
  logRate = 0,
  nativeLogging,
  onSearchFilter,
  className,
}: LogStatsDashboardProps) {
  const t = useTranslations("logging")
  const locale = useLocale()
  const themeColors = useThemeColors()

  // Level distribution data
  const levelData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const log of logs) {
      counts[log.level] = (counts[log.level] || 0) + 1
    }
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([level, count]) => ({
        name: level,
        value: count,
        color: themeColors[LEVEL_THEME[level as LogLevel].chartColor],
      }))
      .sort((a, b) => b.value - a.value)
  }, [logs, themeColors])

  // Module activity data
  const moduleData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const log of logs) {
      counts[log.module] = (counts[log.module] || 0) + 1
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [logs])

  // Volume timeline data
  const volumeData = useMemo(() => computeVolumeBuckets(logs, 5, locale), [logs, locale])
  const errorTrendData = useMemo(() => computeErrorTrendData(volumeData), [volumeData])

  // Summary stats
  const stats = useMemo(() => {
    const errorCount = logs.filter((l) => l.level === "error" || l.level === "fatal").length
    const warnCount = logs.filter((l) => l.level === "warn").length
    const errorRate = logs.length > 0 ? ((errorCount / logs.length) * 100).toFixed(1) : "0"
    const warnRate = logs.length > 0 ? ((warnCount / logs.length) * 100).toFixed(1) : "0"

    const moduleCounts: Record<string, number> = {}
    const traceIds = new Set<string>()
    for (const log of logs) {
      moduleCounts[log.module] = (moduleCounts[log.module] || 0) + 1
      if (log.traceId) traceIds.add(log.traceId)
    }
    const topModule = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1])[0]
    const uniqueModules = Object.keys(moduleCounts).length
    const uniqueTraces = traceIds.size

    let timeSpan = ""
    if (logs.length > 0) {
      const sorted = logs.map((l) => new Date(l.timestamp).getTime()).sort((a, b) => a - b)
      const diffMs = sorted[sorted.length - 1] - sorted[0]
      const diffHours = diffMs / (1000 * 60 * 60)
      if (diffHours < 1) {
        timeSpan = `${Math.round(diffMs / (1000 * 60))}m`
      } else if (diffHours < 24) {
        timeSpan = `${diffHours.toFixed(1)}h`
      } else {
        timeSpan = `${(diffHours / 24).toFixed(1)}d`
      }
    }

    // Error trend: compare last-quarter error rate vs first-three-quarters
    let errorTrend: "up" | "down" | "stable" = "stable"
    if (volumeData.length >= 4) {
      const splitAt = Math.floor(volumeData.length * 0.75)
      const earlyErrors = volumeData.slice(0, splitAt).reduce((sum, b) => sum + b.error, 0)
      const earlyTotal = volumeData
        .slice(0, splitAt)
        .reduce((sum, b) => sum + b.info + b.warn + b.error + b.other, 0)
      const lateErrors = volumeData.slice(splitAt).reduce((sum, b) => sum + b.error, 0)
      const lateTotal = volumeData
        .slice(splitAt)
        .reduce((sum, b) => sum + b.info + b.warn + b.error + b.other, 0)

      const earlyRate = earlyTotal > 0 ? earlyErrors / earlyTotal : 0
      const lateRate = lateTotal > 0 ? lateErrors / lateTotal : 0

      if (lateRate > earlyRate * 1.5 && lateErrors >= 2) errorTrend = "up"
      else if (earlyRate > lateRate * 1.5 && earlyErrors >= 2) errorTrend = "down"
    }

    return {
      errorCount,
      warnCount,
      errorRate,
      warnRate,
      topModule,
      timeSpan,
      uniqueModules,
      uniqueTraces,
      errorTrend,
    }
  }, [logs, volumeData])

  // Top errors: group error-level logs by message prefix
  const topErrors = useMemo(() => {
    const errorLogs = logs.filter((l) => l.level === "error" || l.level === "fatal")
    if (errorLogs.length === 0) return []

    const groups: Record<string, { message: string; count: number }> = {}
    for (const log of errorLogs) {
      const key = log.message.slice(0, 80)
      if (groups[key]) {
        groups[key].count++
      } else {
        groups[key] = { message: key, count: 1 }
      }
    }
    return Object.values(groups)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [logs])

  if (logs.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center py-12 text-muted-foreground", className)}
      >
        <p className="text-sm">{t("dashboard.noData")}</p>
      </div>
    )
  }

  return (
    <div className={cn("space-y-4 p-4", className)}>
      {/* Summary Cards — responsive 1 → 2 → 3 → 4 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Layers}
          label={t("dashboard.totalLogs")}
          value={logs.length.toLocaleString()}
          color="bg-chart-3/10 text-chart-3"
        />
        <StatCard
          icon={AlertTriangle}
          label={t("dashboard.errorRate")}
          value={`${stats.errorRate}%`}
          sub={`${stats.errorCount} ${t("dashboard.errors")}`}
          color="bg-destructive/10 text-destructive"
          trend={stats.errorTrend}
        />
        <StatCard
          icon={Activity}
          label={t("dashboard.topModule")}
          value={stats.topModule?.[0] || "-"}
          sub={stats.topModule ? `${stats.topModule[1]} ${t("panel.logs")}` : undefined}
          color="bg-success/10 text-success"
        />
        <StatCard
          icon={Clock}
          label={t("dashboard.timeSpan")}
          value={stats.timeSpan || "-"}
          color="bg-chart-4/10 text-chart-4"
        />
        <StatCard
          icon={Gauge}
          label={t("dashboard.logRate")}
          value={logRate > 0 ? logRate : "-"}
          sub={logRate > 0 ? t("dashboard.logsPerMinUnit") : undefined}
          color="bg-chart-2/10 text-chart-2"
        />
        <StatCard
          icon={AlertCircle}
          label={t("dashboard.warningRate")}
          value={`${stats.warnRate}%`}
          sub={`${stats.warnCount} ${t("dashboard.warnings")}`}
          color="bg-warning/10 text-warning"
        />
        <StatCard
          icon={Grid3X3}
          label={t("dashboard.uniqueModules")}
          value={stats.uniqueModules}
          color="bg-chart-5/10 text-chart-5"
        />
        <StatCard
          icon={Hash}
          label={t("dashboard.uniqueTraces")}
          value={stats.uniqueTraces}
          color="bg-chart-1/10 text-chart-1"
        />
      </div>

      {nativeLogging?.runtime === "tauri" && (
        <DashboardSection title={t("dashboard.platformLogging")}>
          <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformBackend")}</p>
              <p className="font-medium">{nativeLogging.platformLogging.backend}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformHealth")}</p>
              <p className="font-medium">{nativeLogging.platformLogging.health}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformThreshold")}</p>
              <p className="font-medium">{nativeLogging.platformLogging.minLevel}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformTargets")}</p>
              <p className="font-medium">
                {nativeLogging.activeTargets.length > 0
                  ? nativeLogging.activeTargets.join(", ")
                  : t("panel.nativeLoggingNoTargets")}
              </p>
            </div>
            {nativeLogging.platformLogging.error && (
              <div className="space-y-1 sm:col-span-2 xl:col-span-4">
                <p className="text-xs text-muted-foreground">{t("dashboard.platformHealth")}</p>
                <p className="text-sm text-destructive">{nativeLogging.platformLogging.error}</p>
              </div>
            )}
          </div>
        </DashboardSection>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Level Distribution - Pie Chart */}
        <DashboardSection title={t("dashboard.levelDistribution")}>
          <div
            data-testid="dashboard-chart-pie"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <PieChart>
                <Pie
                  data={levelData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  label={(props: any) =>
                    `${String(props.name ?? "")} ${(((props.percent as number) ?? 0) * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                >
                  {levelData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </DashboardSection>

        {/* Log Volume Timeline - Area Chart */}
        <DashboardSection title={t("dashboard.logVolume")} className="lg:col-span-2">
          <div
            data-testid="dashboard-chart-area"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <AreaChart data={volumeData} margin={CHART_MARGINS.default}>
                <defs>
                  <linearGradient id="logVolumeInfo" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.success} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.success} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="logVolumeWarn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.warning} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.warning} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="logVolumeError" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.destructive} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.destructive} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="info"
                  stackId="1"
                  stroke={themeColors.success}
                  fill="url(#logVolumeInfo)"
                  name={t("levels.info")}
                />
                <Area
                  type="monotone"
                  dataKey="warn"
                  stackId="1"
                  stroke={themeColors.warning}
                  fill="url(#logVolumeWarn)"
                  name={t("levels.warn")}
                />
                <Area
                  type="monotone"
                  dataKey="error"
                  stackId="1"
                  stroke={themeColors.destructive}
                  fill="url(#logVolumeError)"
                  name={t("levels.error")}
                />
                <Area
                  type="monotone"
                  dataKey="other"
                  stackId="1"
                  stroke={themeColors["muted-foreground"]}
                  fill={themeColors["muted-foreground"]}
                  fillOpacity={0.2}
                  name={t("dashboard.otherSeries")}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </DashboardSection>
      </div>

      {/* Bottom Row: Module Activity + Top Errors */}
      {errorTrendData.length > 0 && (
        <DashboardSection title={t("dashboard.errorTrend")}>
          <div
            data-testid="dashboard-chart-line"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <LineChart data={errorTrendData} margin={CHART_MARGINS.default}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="current"
                  stroke={themeColors.destructive}
                  strokeWidth={2}
                  dot={false}
                  name={t("dashboard.currentPeriod")}
                />
                <Line
                  type="monotone"
                  dataKey="previous"
                  stroke={themeColors["muted-foreground"]}
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                  name={t("dashboard.previousPeriod")}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </DashboardSection>
      )}

      {/* Bottom Row: Module Activity + Top Errors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Module Activity - Bar Chart */}
        {moduleData.length > 0 && (
          <DashboardSection title={t("dashboard.moduleActivity")}>
            <div
              data-testid="dashboard-chart-bar"
              className="w-full"
              style={{
                height: `clamp(180px, ${moduleData.length * 32}px, 480px)`,
              }}
            >
              <ResponsiveContainer
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 180 }}
              >
                <BarChart
                  data={moduleData}
                  layout="vertical"
                  margin={{ ...CHART_MARGINS.withYAxis, left: 80 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                    horizontal={false}
                  />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={75} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                  <Bar
                    dataKey="count"
                    fill={themeColors["chart-3"]}
                    radius={[0, 4, 4, 0]}
                    name={t("dashboard.logsSeries")}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </DashboardSection>
        )}

        {/* Top Errors */}
        {topErrors.length > 0 && (
          <DashboardSection title={t("dashboard.topErrors")}>
            <div className="space-y-2">
              {topErrors.map((err, i) => (
                <Button
                  key={i}
                  variant="ghost"
                  className="flex items-start gap-2 w-full justify-start px-2 py-1.5 h-auto text-xs font-normal motion-safe:transition-colors"
                  onClick={() => onSearchFilter?.(err.message)}
                  data-testid={`top-error-${i}`}
                >
                  <Badge variant="destructive" className="text-[10px] shrink-0 mt-0.5">
                    {err.count}
                  </Badge>
                  <span className="text-xs text-muted-foreground break-words line-clamp-2">
                    {err.message}
                  </span>
                </Button>
              ))}
            </div>
          </DashboardSection>
        )}
      </div>
    </div>
  )
}

export default LogStatsDashboard
